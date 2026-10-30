"""OpenAI-compatible client for NVIDIA Nemotron on Nebius Token Factory or the NVIDIA API.

One provider switch (LLM_PROVIDER = nebius | nvidia). Model IDs are resolved from
the provider's /models list by role, never hard-coded, and the startup check fails
loudly if a role has no model. Every call is recorded in a trace: provider, model,
role, tokens, latency, retries and cost at the configured Nebius prices.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

ROOT = Path(__file__).resolve().parents[2]

PROVIDERS = {
    "nebius": {"base": "https://api.tokenfactory.nebius.com/v1", "key": "NEBIUS_API_KEY", "label": "Nebius Token Factory"},
    "nvidia": {"base": "https://integrate.api.nvidia.com/v1", "key": "NVIDIA_API_KEY", "label": "NVIDIA API"},
}

# role → patterns tried in order against the provider's model IDs (case-insensitive)
ROLE_PATTERNS = {
    "planner": [r"nemotron-3-ultra"],
    "fast": [r"nemotron-3[._]5-lightning", r"nemotron-3-nano", r"nemotron-nano-3"],
    "vision": [r"nemotron-3\.5-super-vl", r"nemotron.*vl"],
}

# USD per 1M tokens (input, output) at Nebius Token Factory list prices; verify on switch day.
PRICES = {
    "planner": (1.00, 3.00),
    "fast": (0.06, 0.24),
    "vision": (0.30, 0.90),
}


def load_env(path: Path = ROOT / ".env") -> None:
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


@dataclass
class Call:
    role: str
    model: str
    provider: str
    purpose: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_s: float = 0.0
    retries: int = 0
    ok: bool = True
    error: str = ""
    cost_usd: float = 0.0
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])


class LLMError(RuntimeError):
    pass


def _template(schema: type[BaseModel]) -> dict:
    """A filled-in example of the expected JSON: field name → description (or a nested example)."""
    out = {}
    for name, f in schema.model_fields.items():
        ann = f.annotation
        inner = getattr(ann, "__args__", (None,))[0]
        kind = {bool: "true/false", float: "number", int: "integer", str: "text"}.get(ann, str(ann).replace("typing.", ""))
        text = f"{f.description} ({kind})" if f.description else f"<{kind}>"
        if isinstance(inner, type) and issubclass(inner, BaseModel):
            out[name] = [_template(inner)]
        elif isinstance(ann, type) and issubclass(ann, BaseModel):
            out[name] = _template(ann)
        elif getattr(ann, "__origin__", None) is list:
            out[name] = [f.description or "<item>"]
        else:
            out[name] = text
    return out


class Client:
    def __init__(self, provider: str | None = None, timeout: float = 120.0):
        load_env()
        self.provider = provider or os.environ.get("LLM_PROVIDER", "nvidia")
        if self.provider not in PROVIDERS:
            raise LLMError(f"unknown provider {self.provider!r}")
        cfg = PROVIDERS[self.provider]
        key = os.environ.get(cfg["key"])
        if not key:
            raise LLMError(f"{cfg['key']} is not set (provider {self.provider})")
        self.label = cfg["label"]
        self.http = httpx.Client(base_url=cfg["base"], timeout=timeout,
                                 headers={"Authorization": f"Bearer {key}"})
        self.models: dict[str, str] = {}
        self.trace: list[Call] = []

    def resolve_models(self) -> dict[str, str]:
        ids = [m["id"] for m in self.http.get("/models").raise_for_status().json()["data"]]
        for role, patterns in ROLE_PATTERNS.items():
            for p in patterns:
                hit = next((i for i in ids if re.search(p, i, re.I)), None)
                if hit:
                    self.models[role] = hit
                    break
        missing = [r for r in ("planner", "fast") if r not in self.models]
        if missing:
            raise LLMError(f"{self.label} has no model for roles {missing}; available: {ids[:40]}")
        return self.models

    def _post(self, role: str, messages: list[dict], max_tokens: int, purpose: str) -> tuple[str, Call]:
        model = self.models[role]
        call = Call(role=role, model=model, provider=self.label, purpose=purpose)
        # The track's advice: Ultra reasons (thinking on, more room); the fast model answers directly.
        thinking = role == "planner"
        body = {"model": model, "messages": messages, "max_tokens": max(max_tokens, 12000) if thinking else max_tokens,
                "temperature": 0.2, "chat_template_kwargs": {"enable_thinking": thinking}}
        t = time.time()
        for attempt in range(3):
            try:
                r = self.http.post("/chat/completions", json=body)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < 2:
                    call.retries += 1
                    time.sleep(2 * (attempt + 1))
                    continue
                r.raise_for_status()
                data = r.json()
                break
            except httpx.HTTPError as e:
                if attempt == 2:
                    call.ok, call.error, call.latency_s = False, str(e)[:200], time.time() - t
                    self.trace.append(call)
                    raise LLMError(f"{role} call failed: {e}") from e
                call.retries += 1
                time.sleep(2 * (attempt + 1))
        call.latency_s = round(time.time() - t, 2)
        usage = data.get("usage") or {}
        call.input_tokens = int(usage.get("prompt_tokens", 0))
        call.output_tokens = int(usage.get("completion_tokens", 0))
        pin, pout = PRICES["planner" if model == self.models.get("planner") else role]
        call.cost_usd = round((call.input_tokens * pin + call.output_tokens * pout) / 1e6, 6)
        self.trace.append(call)
        msg = data["choices"][0]["message"]
        return (msg.get("content") or msg.get("reasoning_content") or ""), call

    def json_call(self, role: str, system: str, user: Any, schema: type[BaseModel], purpose: str,
                  max_tokens: int = 1500) -> BaseModel:
        """Ask for JSON matching `schema`; one repair retry on invalid output, then fail visibly."""
        # a list is passed through as multimodal content (text + image parts)
        content = user if isinstance(user, (str, list)) else json.dumps(user, indent=1)
        messages = [{"role": "system", "content": system + "\nReply with ONLY a JSON object with exactly these keys "
                     "(values below describe what to put there; replace them with real content):\n"
                     + json.dumps(_template(schema), indent=1)},
                    {"role": "user", "content": content}]
        text, _ = self._post(role, messages, max_tokens, purpose)
        for attempt in range(2):
            try:
                text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
                s, e = text.find("{"), text.rfind("}")
                obj = json.loads(text[s:e + 1])
                if isinstance(obj, dict) and "properties" in obj and set(obj) <= {"properties", "type", "required", "title"}:
                    obj = obj["properties"]  # a small model sometimes wraps its answer in a schema echo
                return schema.model_validate(obj)
            except (ValueError, ValidationError) as err:
                if attempt == 1:
                    raise LLMError(f"{role} returned invalid JSON after one repair: {err}") from err
                messages += [{"role": "assistant", "content": text},
                             {"role": "user", "content": f"That was invalid ({str(err)[:300]}). Reply with ONLY the corrected JSON object."}]
                text, _ = self._post(role, messages, max_tokens, purpose + " (repair)")
        raise AssertionError("unreachable")

    def trace_dicts(self) -> list[dict]:
        return [c.__dict__ for c in self.trace]
