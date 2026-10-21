#!/bin/sh
# Starts the local engine on http://127.0.0.1:8765. First run: creates the Python 3.12 venv, installs the
# requirements and downloads the models into engine/models (about 1 GB, plus PyTorch).
#   engine/start.sh            SAM 2.1 base-plus
#   engine/start.sh --large    SAM 2.1 large (slower, a little more accurate)
set -e
cd "$(dirname "$0")"
PY=${PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}
export PYTORCH_ENABLE_MPS_FALLBACK=1 SAM2_BUILD_CUDA=0
export HF_HOME="$PWD/models/hf" TORCH_HOME="$PWD/models/torch" HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
if [ ! -x .venv/bin/python ]; then
  echo "Creating the Python environment in engine/.venv …"
  "$PY" -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
MODEL=base_plus
[ "$1" = "--large" ] && MODEL=large
mkdir -p models
CKPT="models/sam2.1_hiera_$MODEL.pt"
if [ ! -f "$CKPT" ]; then
  echo "Downloading SAM 2.1 $MODEL …"
  curl -L --fail -o "$CKPT.part" "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_$MODEL.pt"
  mv "$CKPT.part" "$CKPT"
fi
if [ ! -d models/hf/hub/models--google--owlv2-base-patch16-ensemble ]; then
  echo "Downloading OWLv2 …"
  .venv/bin/python -c "from transformers import Owlv2ForObjectDetection, Owlv2Processor as P; m='google/owlv2-base-patch16-ensemble'; P.from_pretrained(m); Owlv2ForObjectDetection.from_pretrained(m)" >/dev/null
fi
if [ ! -d models/torch/hub/checkpoints ]; then
  echo "Downloading RTMPose and its person detector …"
  .venv/bin/python -c "import sys; sys.path.insert(0, '.'); import pose; pose.RTMPose()" >/dev/null
fi
# from here on the models are local; nothing goes out
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export BARPATH_SAM2=$MODEL
exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
