"""Compares 2D pose models on a real clip without ground truth, using what must be true of a lift:
  - detection: share of frames before the bar is dropped where the lifter is found;
  - wrists on the bar: from lift-off to the catch the near wrist holds the bar, so its distance to the
    tracked bar centre should stay steady (spread = std);
  - segment lengths: the near thigh, shin, upper arm and forearm don't change length (spread = CV);
  - jitter: frame-to-frame acceleration of the joints while the lifter is set up and still.
Usage (repo root): engine/.venv/bin/python engine/eval_pose.py samples/clip.mov samples/clip.browser.json END
END = last frame to score (before the bar is dropped). Writes samples/clip.pose-<model>.json."""
import json
import os
import sys
import tempfile
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import pipeline  # noqa: E402
import pose  # noqa: E402

video, track_file, END = sys.argv[1], sys.argv[2], int(sys.argv[3])
track = json.load(open(track_file))
bar = [None if p is None or p[2] else np.array(p[:2]) for p in track["points"]]
R = track["plate"]["radiusPx"]
cm = 22.5 / R
W, H, fps, times = pipeline.probe(video)

with tempfile.TemporaryDirectory() as tmp:
    files = pipeline.extract_frames(video, tmp)[:END + 1]
    frames = [cv2.cvtColor(cv2.imread(os.path.join(tmp, f)), cv2.COLOR_BGR2RGB) for f in files]

# lift phases from the bar track, using the web app's own analysis via node would be cleaner; simple version:
ys = np.array([b[1] if b is not None else np.nan for b in bar[:END + 1]])
y0 = np.nanmedian(ys[:30])
lift = int(np.argmax(y0 - ys > 1.5 / cm))                   # lift-off: 1.5 cm up
peak = lift + int(np.nanargmin(ys[lift:lift + int(1.5 * fps)]))
catch = peak + int(0.35 * fps)                               # about the receive
models = {"mediapipe": pose.MediaPipePose, "rtmpose": lambda: pose.RTMPose("performance")} if len(sys.argv) < 5 else {n: {"mediapipe": pose.MediaPipePose, "rtmpose": lambda: pose.RTMPose("performance")}[n] for n in sys.argv[4].split(",")}
report = {}
for name, make in models.items():
    m = make()
    t0 = time.time()
    out = []
    for i, f in enumerate(frames):
        b = bar[i] if i < len(bar) else None
        out.append(m(f, b) if name != "mediapipe" else m(f, b, dt_ms=1000 / fps))
    secs = time.time() - t0
    json.dump({"model": m.name, "frames": [None if L is None else np.round(L, 2).tolist() for L in out]}, open(video.rsplit(".", 1)[0] + f".pose-{name}.json", "w"))

    found = [L is not None for L in out]
    # near side = the side with the higher mean visibility over the clip
    vis = [np.mean([L[[11, 13, 15, 23, 25, 27], 3].mean() if s == 0 else L[[12, 14, 16, 24, 26, 28], 3].mean() for L in out if L is not None]) for s in (0, 1)]
    s = int(np.argmax(vis))
    J = {n: [11, 12][s] if n == "sh" else idx[s] for n, idx in
         {"sh": None, "el": [13, 14], "wr": [15, 16], "hip": [23, 24], "kn": [25, 26], "an": [27, 28]}.items()}
    P = lambda i, n: out[i][J[n], :2] if out[i] is not None else None
    d = [np.hypot(*(P(i, "wr") - bar[i])) * cm for i in range(lift, min(catch, END) + 1) if out[i] is not None and bar[i] is not None]
    seg = {}
    for a, b in (("hip", "kn"), ("kn", "an"), ("sh", "el"), ("el", "wr")):
        L = [np.hypot(*(P(i, a) - P(i, b))) for i in range(END + 1) if out[i] is not None]
        seg[f"{a}-{b}"] = round(float(np.std(L) / np.mean(L)) * 100, 1)
    still = [i for i in range(10, lift - 10) if all(out[k] is not None for k in (i - 1, i, i + 1))]
    jit = [np.mean([np.hypot(*(out[i + 1][j, :2] - 2 * out[i][j, :2] + out[i - 1][j, :2])) for j in J.values()]) * cm for i in still]
    report[name] = {
        "model": m.name, "ms_per_frame": round(secs / len(frames) * 1000), "found": f"{sum(found)}/{len(found)}",
        "near_side": "left" if s == 0 else "right",
        "wrist_bar_cm": {"median": round(float(np.median(d)), 1), "std": round(float(np.std(d)), 2), "max": round(float(np.max(d)), 1)},
        "segment_cv_pct": seg, "still_jitter_cm": round(float(np.mean(jit)), 3),
        "mean_visibility_near": round(float(vis[s]), 2),
    }
print(json.dumps({"frames": END + 1, "liftoff": lift, "peak": peak, "catch_approx": catch, **report}, indent=1))
