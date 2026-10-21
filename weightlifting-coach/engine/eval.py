"""Runs the engine pipeline on the generated clips and writes samples/<clip>.engine.json (start mark given, as
the web app sends it) and samples/<clip>.engine-owl.json (plate found by OWLv2). Score them with
  node --import ./tests/dom-stub.js tests/score-result.js
Run from the repository root: engine/.venv/bin/python engine/eval.py [clip ...]"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import pipeline  # noqa: E402

clips = sys.argv[1:] or ["snatch60", "snatch30hard", "cj30", "snatch30occl", "snatch30gym"]
t0 = time.time()
models = pipeline.Models()
print(f"models loaded in {time.time() - t0:.1f} s on {pipeline.DEVICE}", flush=True)
for name in clips:
    truth = json.load(open(f"samples/{name}.truth.json"))
    for tag, hint in (("engine", {"frame": 0, "x": truth["start"]["x"], "y": truth["start"]["y"], "r": truth["plateRadiusPx"]}), ("engine-owl", None)):
        res = pipeline.analyze(models, f"samples/{name}.mp4", lift=truth["lift"], facing=truth["facing"], hint=hint)
        json.dump(res, open(f"samples/{name}.{tag}.json", "w"))
        print(f"{name} {tag}: {res['producer']['seconds']} s, radius {res['plate']['radiusPx']} px, ratio {res['plate']['axisRatio']}, "
              f"low {sum(1 for p in res['points'] if p and p[2])}/{len(res['points'])}", flush=True)
