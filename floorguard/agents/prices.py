"""Current prices for the controls, from the web: Tavily searches industrial suppliers, Nemotron reads the pages.

Tavily returns supplier pages with their text; the fast Nemotron model picks each page's price for that
control; Python keeps a price only if that exact figure appears in the page text, and only inside a
plausible range. Controls without a unit price on the web (floor markings, a moved crossing, barriers)
keep their labelled estimates. Results are cached for the day so runs stay stable and credits last.
"""
from __future__ import annotations

import json
import os
import re
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import httpx
from pydantic import BaseModel, Field

from ..sim.scene import EXAMPLE_COSTS
from .llm import Client, load_env

CACHE = Path(__file__).resolve().parents[2] / "runs" / "prices"
SUPPLIERS = ["uline.com", "globalindustrial.com", "grainger.com", "zoro.com", "seton.com"]
# control → (search query, plausible unit price range in USD)
SEARCH = {
    "ped_gate": ("self-closing safety swing gate for pedestrian walkway", (80, 4000)),
    "warning_light": ("virtual LED projector safety sign forklift warning", (150, 6000)),
    "mirror": ("convex safety mirror 26 inch indoor", (25, 800)),
    "speed_sign": ("forklift speed limit sign warehouse", (8, 400)),
}
NAMES = {"ped_gate": "pedestrian safety gate", "warning_light": "forklift warning floor light (LED projector)",
         "mirror": "convex safety mirror", "speed_sign": "speed limit sign"}
PRICE = re.compile(r"\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)")


class PagePrice(BaseModel):
    url: str = Field(description="the page URL, exactly as given")
    product: str = Field(description="the product name on that page")
    price_usd: float = Field(description="its unit price in US dollars, exactly as printed on the page; 0 if this page is not that product")


class Found(BaseModel):
    pages: list[PagePrice]


def _search(key: str, control: str) -> tuple[str, list[dict]]:
    q, _ = SEARCH[control]
    r = httpx.post("https://api.tavily.com/search", timeout=40, headers={"Authorization": f"Bearer {key}"},
                   json={"query": f"{q} price", "search_depth": "advanced", "max_results": 5,
                         "include_raw_content": "text", "include_domains": SUPPLIERS})
    r.raise_for_status()
    return control, r.json().get("results", [])


def _windows(text: str, width: int = 160, limit: int = 6) -> str:
    """The parts of a page around its dollar figures (the model reads these, not the whole page)."""
    out = []
    for m in list(PRICE.finditer(text))[:limit]:
        out.append(text[max(0, m.start() - width): m.end() + 40].replace("\n", " "))
    return " … ".join(out)


def fetch(llm: Client) -> dict:
    """{control: {low, high, used, sources: [{url, product, price}]}} plus search stats; cached per day."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{date.today().isoformat()}.json"
    if cached.exists():
        data = json.loads(cached.read_text())
        data["cached"] = True
        return data
    load_env()
    key = os.environ.get("TAVILY_API_KEY")
    if not key:
        return {"available": False, "note": "TAVILY_API_KEY is not set; example costs used", "items": {}}
    t = time.time()
    with ThreadPoolExecutor(len(SEARCH)) as pool:
        results = dict(pool.map(lambda c: _search(key, c), SEARCH))
    pages, texts = [], {}
    for control, res in results.items():
        for r in res:
            text = (r.get("raw_content") or "") + " " + (r.get("content") or "")
            if PRICE.search(text):
                texts[r["url"]] = text
                pages.append({"control": NAMES[control], "id": control, "url": r["url"], "title": r.get("title", ""),
                              "price_text": _windows(text)})
    search_s = round(time.time() - t, 2)
    items: dict = {}
    if pages:
        found = llm.json_call("fast", "You read supplier web pages. For each page, give the unit price in US dollars of the named control, "
                              "exactly as printed. If the page is not that product (an accessory, a different item, a category page), price_usd is 0.",
                              {"pages": [{k: p[k] for k in ("control", "url", "title", "price_text")} for p in pages]}, Found, "read supplier prices",
                              max_tokens=2500)
        by_url = {p["url"]: p for p in pages}
        for f in found.pages:
            p = by_url.get(f.url)
            if not p or f.price_usd <= 0:
                continue
            lo, hi = SEARCH[p["id"]][1]
            printed = {float(x.replace(",", "")) for x in PRICE.findall(texts[f.url])}
            if f.price_usd in printed and lo <= f.price_usd <= hi:  # the number must be on the page, and plausible
                items.setdefault(p["id"], {"sources": []})["sources"].append({"url": f.url, "product": f.product, "price": f.price_usd})
    for control, it in items.items():
        prices = [s["price"] for s in it["sources"]]
        it.update(low=min(prices), high=max(prices), used=round(statistics.median(prices)))
    data = {"available": True, "date": date.today().isoformat(), "searches": len(SEARCH), "pages_read": len(pages),
            "search_s": search_s, "items": items, "cached": False}
    cached.write_text(json.dumps(data, indent=1))
    return data


def costs_from(prices: dict) -> dict:
    """The cost table for this run: sourced unit prices where found, labelled estimates elsewhere."""
    return {**EXAMPLE_COSTS, **{c: it["used"] for c, it in (prices.get("items") or {}).items()}}
