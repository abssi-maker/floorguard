# FloorGuard

**Find the near miss before it finds your people.**

FloorGuard helps warehouse safety managers test a blind-intersection change before buying it. **NVIDIA Nemotron on Nebius Token Factory** proposes changes, runs each in a deterministic simulator, and revises its recommendation from the measured results.

> Near-misses at blind corners mostly go unreported, so a corner usually gets fixed after someone is hurt. FloorGuard shows where close calls will happen, in simulation, before the first injury, and which fix actually removes them.

---

## The problem
A forklift lane passes a pedestrian crossing. A steel column and pallet stacks hide each from the other until the last second. The safety manager can buy a mirror, a speed sign or a stop line, move the crossing, or add a gate or a warning light. Today that choice is made by habit or a vendor's pitch, because nothing tests the options **at that corner** before money is spent. A mirror only helps people who actually look at it.

Forklift safety is a compliance problem as well as a human one: OSHA's powered-industrial-truck standard (29 CFR 1910.178) was **#8 on OSHA's most-cited list for FY2025** (preliminary: 1,826 violations) ([OSHA Top 10](https://www.osha.gov/top10citedstandards)). The UK HSE calls separating pedestrians and vehicles *"the most effective way"* to keep both safe, with mirrors for bends that can't be avoided ([HSE](https://hse.gov.uk/workplacetransport/separating.htm)).

## What it does
**Dashboard.** Every simulation you have run, latest first: close calls per shift today and with the recommended fix, crossings simulated, stress tests passed, Nemotron calls and cost.

**New simulation**, in six visible steps:
1. **Photo.** Upload a photo of the intersection (a new warehouse, or a layout you plan to change).
2. **Nemotron reads the photo.** Nemotron 3.5 Super VL finds the vehicles, people, the crossing, and what blocks a line of sight; its boxes appear on the photo.
3. **2D map.** The scene becomes a floor plan in metres. A person confirms it (one photo can't give exact metres).
4. **Simulating crossings.** Every control is simulated alone on the same 10,000 random crossings; the screen plays real simulated crossings, marks each close call, and builds the heat.
5. **Blind spots.** What a person waiting to cross cannot see, and how late they first see the forklift.
6. **Recommendation.** **Nemotron 3 Ultra** proposes packages, a **fast Nemotron** model picks stress tests aimed at their weak points, the simulator measures everything, and **Ultra revises** from the results. **Only Python decides what passes.**

**Report.** The answer in your units (close calls per shift, truck delay, cost), a before/after view, the stress-test heatmap, replays of the worst close call, how Nemotron decided (every call with its model, latency and cost), and a one-page decision brief to print.

**Replay.** Any recorded run can be replayed through the same six steps without calling a model.

## How NVIDIA Nemotron on Nebius Token Factory is used

| Step | Model | Why this size |
|---|---|---|
| Draft the scene from the photo | **Nemotron 3.5 Super VL** (120B) | Vision |
| Propose packages; revise from measured results | **Nemotron 3 Ultra** (550B) | The track's advice: *"Reach for Nemotron 3 Ultra when you need serious reasoning."* |
| Pick stress tests; write the decision brief | **Nemotron 3.5 Lightning** (30B, 3B active, Nano-class) | *"…let Nano or Super handle the fast, everyday calls, so your app stays responsive."* |
| Simulate, check limits, rank | Python | The model never computes outcomes and cannot change the manager's limits |

- **Model IDs** are resolved from the provider's model list at startup, never hard-coded.
- **Every call is recorded:** provider, model, role, tokens, latency, retries, and cost at Nebius list prices. The page shows them on each step.
- **Structured output:** validated by Pydantic, with one repair retry, then a visible failure. There is no canned fallback.

## What a recorded run found
Simulated close calls per 1,000 forklift–pedestrian interactions (the same 10,000 random crossings for every option). Default assumptions: 85% of pedestrians look, 90% of drivers are attentive, 70% obey a speed sign, 90% use a gate as intended, 50% check a mirror.

**Each control alone:**

| Option | Close calls / 1,000 |
|---|---|
| Today | 53.9 |
| Convex mirror | 35.4 |
| 8 km/h sign | 39.4 |
| Stop line | 36.9 |
| Warning light | 27.4 |
| Pedestrian gate | 6.7 |
| Move the crossing 3 m | 25.3 |

**The usual fix, mirror + 8 km/h sign: 29.1.**

**What the agent did:**
1. Its first proposals centred on the gate.
2. The fast model's stress test *"40% of people prop the gate or step around it"* broke the gate alone: 6.7 → 22.7.
3. Ultra revised with combinations.

The recommendation varies between runs (the model explores different packages):

| Run | Recommendation | Close calls / 1,000 | Example cost |
|---|---|---|---|
| 1 | Mirror + gate | 4.2 | $1,350 |
| 2 | Moved crossing + gate + mirror | 2.9 | $2,150 |
| 3 | Gate + mirror + warning light | 3.1 | $4,850 |

All three met the limits and held up under every stress test.

**The insight the model surfaced:** at this corner, near-misses come mostly from people stepping out without looking at a blind spot. A mirror only helps people who look, so the controls that force a stop-and-look (a gate), or remove the blind spot (moving the crossing), do most of the work. They only hold if people actually use them, which is why the stress tests matter.

## Evidence: does the model earn its place?
Measured, and reported whatever the result. Files in [`evidence/`](evidence/).

**Agent versus random search** (same budget of 20 simulations, same pass rule, same stress tests):

| | Found a package that passes and holds up | Median close calls / 1,000 | Median example cost |
|---|---|---|---|
| Nemotron agent (3 runs) | **3 of 3** | 3.1 | **$2,150** |
| Random search (20 seeds) | 8 of 20 (40%) | 3.2 | $4,800 |

The agent is more reliable and cheaper. When random search succeeds, it reaches similar quality. Three agent runs is a small sample.

**Routed versus everything on Ultra** (same loop):

| | Fast-role calls | Total model time | Cost |
|---|---|---|---|
| Routed | 3.7–5.9 s | 37–81 s | $0.008–0.013 |
| All on Ultra | 34.6 s | 99 s | $0.014 |

Routing makes the fast calls about 7× quicker. The cost difference is small at this scale.

## The simulation (and its limits)
- **Model:** vectorized 2D crossing events.
  - Forklifts: speed 8–12 km/h, reaction 0.75–1.5 s, braking 1.5–2.5 m/s².
  - Pedestrians: 1.2–1.5 m/s.
  - Line of sight: blocked by obstacles above eye height.
- **Controls:**
  - a mirror helps only those who check it;
  - a sign or stop line only those who comply;
  - a gate makes people stop and look, if they use it;
  - moving the crossing invites a share of people to keep using the old route.
  - Each control's assumption is shown and adjustable.
- **A close call** is time-to-collision under 1.5 s, post-encroachment time under 1.0 s, or contact. These are surrogate-safety measures in the style of the FHWA Surrogate Safety Assessment Model ([FHWA](https://www.fhwa.dot.gov/publications/research/safety/03050/02.cfm)).
- **Fair comparison:** every option runs on the same random crossings (common random numbers). A 95% upper bound appears next to every rate, using the rule of three at zero.
- **Tests:** 15 automated tests (`uv run pytest`): determinism, sightline geometry, the textbook stopping distance, the confidence bounds, package bounds, and the behaviour of each control.

**Limits:**
- These are **simulated close calls, not injury predictions.**
- The map is a hand-confirmed draft from one photo; distances are approximate.
- Behaviour parameters are assumptions, not measurements of your site.
- One intersection; a simplified 2D model.
- Costs are illustrative; enter your quotes.
- It supports a decision; it does not certify safety.

**A documented failure:** the pedestrian gate on its own looks best (6.7), but fails once 40% of people bypass it (22.7). FloorGuard reports that, and recommends combinations that hold.

## Run it
```sh
uv sync
cp .env.example .env          # set NEBIUS_API_KEY, or NVIDIA_API_KEY with LLM_PROVIDER=nvidia
uv run python -m floorguard run                 # one full agent run, printed as it goes
uv run uvicorn floorguard.api:app --port 8765   # the web app; open http://localhost:8765/access/<key>
uv run python -m floorguard.baselines search    # agent versus random search
uv run python -m floorguard.baselines routing   # routed versus all-Ultra
uv run pytest
```
Access is by link: set `FLOORGUARD_KEYS=judge:<key>,owner:<key>` in `.env`, then open `/access/<key>` (add `?next=/new` to land on a page). Without a link every page is locked.

Every run is saved in `runs/<id>.json`, with inputs, seed, every model call and every simulation result.

## Feedback on Nebius Token Factory and NVIDIA Nemotron
- **The OpenAI-compatible API** made switching between development and Token Factory a single setting.
- **Nemotron 3 Ultra:** good structured planning that cites the measured numbers. It needed one JSON repair in one run, and its calls take 12–23 s.
- **Nemotron 3.5 Lightning:** fast (about 1–3.5 s) and reliable for small structured tasks, once given a filled-in example instead of a raw JSON schema. On the first attempt it echoed the schema back.
- **Nemotron 3.5 Super VL:**
  - found the crossing, the column and the pallet stacks from one photo;
  - labeled reach trucks as counterbalance forklifts;
  - in one test, called a belt loader "passenger stairs."
  - It's good enough for a draft, but needs human confirmation.
- **Model availability differed between endpoints** (some Nemotron IDs returned 404 on the development endpoint), so model IDs are resolved from `/models` at startup.

## Credits and disclosure
- Photo: "Modern warehouse with pallet rack storage system" by Axisadman, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Modern_warehouse_with_pallet_rack_storage_system.jpg), CC BY-SA 3.0.
- This is a new project built during the submission period. It reuses only the author's earlier domain research method, not code.
- MIT license.
