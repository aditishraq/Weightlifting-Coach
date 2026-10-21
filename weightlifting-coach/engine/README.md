# Weightlifting Coach engine

An optional local server that measures the bar path with heavier models than a browser can run. The web app
finds it at `http://127.0.0.1:8765` when it loads and then offers **High-quality analysis (local engine)**.
Without it, the app uses its in-browser pipeline as before.

Nothing leaves the machine: the server listens on 127.0.0.1 only, accepts requests only from pages served
from localhost, and runs with the Hugging Face hub offline and telemetry off after the first download.
Uploaded videos go to a temporary file that is deleted when the job ends.

## Start

```sh
engine/start.sh            # SAM 2.1 base-plus (default)
engine/start.sh --large    # SAM 2.1 large
```

The first run needs Python 3.12 (`brew install python@3.12`) and an internet connection. It:
1. creates `engine/.venv` and installs `requirements.txt` (PyTorch with Apple's MPS backend, SAM 2.1 built
   without CUDA, OWLv2 through `transformers`, FastAPI);
2. downloads `models/sam2.1_hiera_base_plus.pt` (309 MB) from Meta, OWLv2
   (`google/owlv2-base-patch16-ensemble`, ~600 MB) into `models/hf`, and RTMPose-x with its YOLOX-x person
   detector (~570 MB, from OpenMMLab) into `models/torch`.

After that it starts offline. Environment set by the script: `PYTORCH_ENABLE_MPS_FALLBACK=1`,
`SAM2_BUILD_CUDA=0`, `HF_HOME=engine/models/hf`, `HF_HUB_OFFLINE=1`.

## What it does

`pipeline.py`, per video:
1. ffprobe reads every frame's presentation time; ffmpeg writes every frame as a JPEG for SAM 2.
2. The plate on the start frame: the start mark sent by the app (found automatically there or placed by
   you), else the best OWLv2 box (round, confident, largest).
3. SAM 2.1 tracks the plate's mask forwards and backwards from that frame.
4. Each frame's mask outline gets the plate's ellipse (semi-axes from the first 0.3 s) fitted by robust
   Gauss–Newton for the centre only, so a hand or a passer-by over part of the plate is rejected rather than
   averaged in. Frames whose mask shrinks, loses its shape or jumps are flagged low confidence.
5. Scale: 22.5 cm over the plate's larger semi-axis, measured on the plate face's edge where it shows on both
   sides of the centre (the side wall of a thick plate shows on one side only when the camera isn't side-on).
6. Body: RTMPose-x (Halpe-26: body and feet) on every frame, for the person whose wrists are on the bar; the
   joints are mapped to MediaPipe's 33-point layout so the web app's overlay and checks read them as usual.
   Each frame gets a confidence: joint visibility, wrist-to-bar distance, and how side-on the camera is.
   `BARPATH_POSE=mediapipe` or `none` switches it.

The result (`docs/result-format.md`) holds positions, times and the scale. The web app analyses it with the
same code as a browser track.

## API

See `docs/result-format.md`: `GET /health`, `POST /analyze`, `GET /jobs/{id}`.

## Testing

```sh
engine/.venv/bin/python engine/eval.py              # writes samples/*.engine.json and *.engine-owl.json
node --import ./tests/dom-stub.js tests/score-result.js
```
