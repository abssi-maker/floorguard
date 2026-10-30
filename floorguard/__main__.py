"""python -m floorguard run   — one full agent run, printing progress."""
import json
import sys

from .agents.loop import run


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        rec = run(progress=lambda e: print(json.dumps(e, default=str)[:600], flush=True))
        print(f"\nrun {rec['id']}: {rec['verdict']} · {rec['simulations']} simulations · {len(rec['trace'])} model calls · {rec['wall_s']} s")
    else:
        print(__doc__)


main()
