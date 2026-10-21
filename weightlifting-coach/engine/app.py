"""Local analysis engine for Weightlifting Coach: http://127.0.0.1:8765. API in docs/result-format.md."""
import json
import os
import queue
import tempfile
import threading
import uuid

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import pipeline

app = FastAPI(title="Weightlifting Coach engine", version=pipeline.VERSION)
# only pages served from this machine may call it
app.add_middleware(CORSMiddleware, allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
                   allow_methods=["GET", "POST"], allow_headers=["*"])

jobs = {}
work = queue.Queue()
models = {"m": None, "error": None}


def load_models():
    try:
        models["m"] = pipeline.Models()
    except Exception as e:  # reported by /health
        models["error"] = f"{type(e).__name__}: {e}"


def worker():
    """One job at a time: the models share the GPU."""
    while True:
        jid, path, opts = work.get()
        job = jobs[jid]
        try:
            while models["m"] is None and models["error"] is None:
                job.update(stage="Loading the models", progress=0.0)
                threading.Event().wait(0.5)
            if models["error"]:
                raise RuntimeError(models["error"])
            job["status"] = "running"
            job["result"] = pipeline.analyze(models["m"], path, progress=lambda s, p: job.update(stage=s, progress=round(p, 3)), **opts)
            job.update(status="done", stage="Done", progress=1.0)
        except Exception as e:
            job.update(status="error", error=f"{e}")
        finally:
            os.remove(path)


threading.Thread(target=load_models, daemon=True).start()
threading.Thread(target=worker, daemon=True).start()


@app.get("/health")
def health():
    m = models["m"]
    return {"ok": models["error"] is None, "version": pipeline.VERSION, "device": pipeline.DEVICE,
            "models": {"detector": pipeline.DETECTOR, "tracker": m.sam2_name if m else None,
                       "pose": (m.pose.name if m.pose else None) if m else None, "ready": m is not None},
            "error": models["error"]}


@app.post("/analyze")
async def analyze(video: UploadFile = File(...), lift: str = Form("snatch"), facing: int = Form(1),
                  weightKg: float | None = Form(None), hint: str | None = Form(None),
                  x_wl_coach: str | None = Header(None)):
    # a custom header makes the browser ask first (CORS preflight), which only localhost pages pass; without
    # it any website could start jobs here with a plain form post
    if x_wl_coach != "1":
        raise HTTPException(403, "missing X-WL-Coach header")
    if lift not in ("snatch", "clean", "cj") or facing not in (1, -1):
        raise HTTPException(400, "lift must be snatch, clean or cj; facing 1 or -1")
    h = json.loads(hint) if hint else None
    if h is not None and not all(isinstance(h.get(k), (int, float)) for k in ("frame", "x", "y", "r")):
        raise HTTPException(400, "hint needs numeric frame, x, y and r")
    fd, path = tempfile.mkstemp(prefix="wlcoach-", suffix=os.path.splitext(video.filename or "")[1] or ".mp4")
    with os.fdopen(fd, "wb") as f:
        while chunk := await video.read(1 << 20):
            f.write(chunk)
    jid = uuid.uuid4().hex[:12]
    jobs[jid] = {"status": "queued", "stage": "Waiting", "progress": 0.0}
    work.put((jid, path, {"lift": lift, "facing": facing, "weight_kg": weightKg, "hint": h, "name": video.filename}))
    return {"job": jid}


@app.get("/jobs/{jid}")
def job(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    return jobs[jid]
