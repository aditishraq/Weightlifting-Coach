"""Bar-end measurement for one video: find the plate, track its mask with SAM 2.1, fit its centre per frame.

The result follows docs/result-format.md. Analysis (smoothing, phases, readout, checks) stays in the web app,
so both modes are analysed by the same code.
"""
import json
import os
import subprocess
import tempfile
import time

import cv2
import numpy as np
import torch

VERSION = "0.1.0"
DETECTOR = "google/owlv2-base-patch16-ensemble"
SAM2 = {
    "base_plus": ("configs/sam2.1/sam2.1_hiera_b+.yaml", "sam2.1_hiera_base_plus.pt"),
    "large": ("configs/sam2.1/sam2.1_hiera_l.yaml", "sam2.1_hiera_large.pt"),
}
MODELS = os.path.join(os.path.dirname(__file__), "models")
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
POSE = os.environ.get("BARPATH_POSE", "rtmpose")   # rtmpose | mediapipe | none


class Models:
    """Loaded once and reused across jobs."""

    def __init__(self, sam2_name=os.environ.get("BARPATH_SAM2", "base_plus")):
        from sam2.build_sam import build_sam2_video_predictor
        from transformers import Owlv2ForObjectDetection, Owlv2Processor

        cfg, ckpt = SAM2[sam2_name]
        self.sam2_name = f"sam2.1_hiera_{sam2_name}"
        self.sam = build_sam2_video_predictor(cfg, os.path.join(MODELS, ckpt), device=DEVICE)
        self.owl_proc = Owlv2Processor.from_pretrained(DETECTOR)
        self.owl = Owlv2ForObjectDetection.from_pretrained(DETECTOR).to(DEVICE).eval()
        import pose
        self.pose_kind = POSE
        self.pose = {"rtmpose": lambda: pose.RTMPose("performance"), "mediapipe": pose.MediaPipePose}.get(POSE, lambda: None)()


# ---------- video ----------

def probe(path):
    """Frame size, nominal frame rate and every frame's presentation time (s)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,avg_frame_rate,r_frame_rate:frame=best_effort_timestamp_time",
         "-of", "json", path], capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    st = info["streams"][0]
    num, den = (int(v) for v in (st.get("avg_frame_rate") or st["r_frame_rate"]).split("/"))
    times = [float(f["best_effort_timestamp_time"]) for f in info.get("frames", []) if f.get("best_effort_timestamp_time")]
    t0 = times[0] if times else 0.0
    # the mean rate from the frame times themselves: avg_frame_rate is wrong on variable-rate phone clips
    fps = (len(times) - 1) / (times[-1] - t0) if len(times) > 1 and times[-1] > t0 else (num / den if den else 30.0)
    return st["width"], st["height"], fps, [t - t0 for t in times]


def extract_frames(path, folder):
    """Every decoded frame as a high-quality JPEG named 00000.jpg …, which is what SAM 2 reads."""
    subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-fps_mode", "passthrough", "-q:v", "1",
                    "-start_number", "0", os.path.join(folder, "%05d.jpg")], check=True)
    return sorted(f for f in os.listdir(folder) if f.endswith(".jpg"))


# ---------- finding the plate ----------

def detect_plate(models, frame_rgb):
    """Best plate box [x0, y0, x1, y1] on one frame with OWLv2, or None. Among confident boxes it prefers
    round ones and then the largest: the lifter's plate is nearest the camera."""
    from PIL import Image

    img = Image.fromarray(frame_rgb)
    queries = [["a weight plate", "a bumper plate on a barbell", "a round barbell plate"]]
    inputs = models.owl_proc(text=queries, images=img, return_tensors="pt").to(DEVICE)
    with torch.inference_mode():
        out = models.owl(**inputs)
    # OWLv2 pads the image to a square, so boxes come back relative to the longer side
    side = max(img.size)
    post = getattr(models.owl_proc, 'post_process_grounded_object_detection', None) or models.owl_proc.post_process_object_detection
    res = post(out, threshold=0.1, target_sizes=torch.tensor([[side, side]]))[0]
    best, best_key = None, None
    for box, score in zip(res["boxes"].cpu().numpy(), res["scores"].cpu().numpy()):
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        if min(w, h) < 12 or min(w, h) / max(w, h) < 0.6:
            continue
        key = (score > 0.25, max(w, h))
        if best_key is None or key > best_key:
            best, best_key = [float(x0), float(y0), float(x1), float(y1)], key
    return best


# ---------- measuring a mask ----------

def outline(mask):
    """Boundary points of the largest region of a boolean mask, as float (N, 2) x, y."""
    m = mask.astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return None, 0
    c = max(cs, key=cv2.contourArea)
    return c[:, 0, :].astype(np.float64), float(cv2.contourArea(c))


def fit_centre(pts, a, b, start):
    """Centre of an axis-aligned ellipse with known semi-axes a, b through the outline points, by Gauss–Newton
    with Tukey weights: points on an occluder's edge don't lie on the plate's ellipse and drop out.
    Returns (x, y, inlier share)."""
    x, y = start
    c = max(1.5, 0.03 * max(a, b)) * 2.3
    w = np.ones(len(pts))
    for _ in range(15):
        dx, dy = (pts[:, 0] - x) / a, (pts[:, 1] - y) / b
        q = np.hypot(dx, dy) + 1e-9
        res = (q - 1) * np.sqrt(a * b)
        w = np.where(np.abs(res) < c, (1 - (res / c) ** 2) ** 2, 0.0)
        # d res / d (x, y)
        jx, jy = -dx / (a * q) * np.sqrt(a * b), -dy / (b * q) * np.sqrt(a * b)
        J = np.stack([jx, jy], 1)
        A = (J * w[:, None]).T @ J
        if np.linalg.det(A) < 1e-9:
            break
        step = np.linalg.solve(A, -(J * w[:, None]).T @ res)
        x, y = x + step[0], y + step[1]
        if np.hypot(*step) < 1e-3:
            break
    inl = float(np.mean(np.abs((np.hypot((pts[:, 0] - x) / a, (pts[:, 1] - y) / b) - 1) * np.sqrt(a * b)) < c / 2.3))
    return float(x), float(y), inl


def radial_centre(gray, cx, cy, R):
    """Sub-pixel plate centre near (cx, cy): the point nearest, in least squares, every edge-gradient line inside
    the plate that points roughly at the centre (rim, face rings, hub). Same method as radialCenter in
    js/ncc.js. None if it doesn't settle near the start."""
    H, W = gray.shape
    x0, y0 = max(1, int(cx - R - 4)), max(1, int(cy - R - 4))
    x1, y1 = min(W - 1, int(cx + R + 5)), min(H - 1, int(cy + R + 5))
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None
    crop = gray[y0:y1, x0:x1].astype(np.float64)
    gx, gy = cv2.Sobel(crop, cv2.CV_64F, 1, 0, ksize=3), cv2.Sobel(crop, cv2.CV_64F, 0, 1, ksize=3)
    m2 = gx * gx + gy * gy
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    m = np.sqrt(m2) + 1e-12
    nx, ny = -gy / m, gx / m
    x, y = cx, cy
    for _ in range(4):
        dx, dy = xs - x, ys - y
        rr = np.hypot(dx, dy) + 1e-12
        sel = (rr > 0.08 * R) & (rr < R + 3) & (m2 > 0.01 * m2.max()) & (np.abs(gx * dx + gy * dy) >= np.cos(np.radians(20)) * m * rr)
        if sel.sum() < 30:
            return None
        w, a1, a2 = m2[sel], nx[sel], ny[sel]
        d = a1 * xs[sel] + a2 * ys[sel]
        A = np.array([[np.sum(w * a1 * a1), np.sum(w * a1 * a2)], [np.sum(w * a1 * a2), np.sum(w * a2 * a2)]])
        if np.linalg.det(A) <= 0:
            return None
        nxt = np.linalg.solve(A, [np.sum(w * a1 * d), np.sum(w * a2 * d)])
        step = np.hypot(nxt[0] - x, nxt[1] - y)
        x, y = float(nxt[0]), float(nxt[1])
        if step > 0.3 * R:
            return None
        if step < 0.01:
            break
    return (x, y) if np.hypot(x - cx, y - cy) < 0.3 * R else None


def rim_scale(gray, x, y, a, b, K=180):
    """Semi-axes (a, b, share of rays) of the plate's outer rubber around the ellipse (x, y, a, b) from SAM's
    mask: the largest concentric copy, scale 0.85..1.25, on which at least a fifth of the rays have a clear
    edge on both sides of the centre, then refitted to those edge points. SAM's mask often stops at a face ring or inside a dark rim; this
    finds the outermost concentric edge, as js/plate.js does. The mask's own axes if none."""
    t = np.linspace(0, 2 * np.pi, K, endpoint=False)
    s = np.linspace(0.8, 1.3, 201)                              # scales along each ray
    rho = a * b / np.sqrt((b * np.cos(t)) ** 2 + (a * np.sin(t)) ** 2)
    mx = (x + np.outer(np.cos(t) * rho, s)).astype(np.float32)
    my = (y + np.outer(np.sin(t) * rho, s)).astype(np.float32)
    prof = cv2.remap(gray.astype(np.float32), mx, my, cv2.INTER_LINEAR, borderValue=np.nan)
    step = (s[1] - s[0]) * rho[:, None]                         # px per sample on each ray
    k = np.maximum(1, np.round(1.0 / step).astype(int))         # ±1 px difference
    d = np.full(prof.shape, np.nan)
    for i in range(K):
        ki = k[i, 0]
        d[i, ki:-ki] = np.abs(prof[i, 2 * ki:] - prof[i, :-2 * ki])
    floor = max(6.0, 4 * np.nanmedian(d))
    peaks = [[] for _ in range(K)]
    for i in range(K):
        row = d[i]
        for j in range(1, len(row) - 1):
            if row[j] >= floor and row[j] >= row[j - 1] and row[j] > row[j + 1]:
                peaks[i].append(s[j])
    band = max(0.012, 1.5 / max(a, b))
    near1 = lambda kk: {i: min(p, key=lambda v: abs(v - kk)) for i, p in enumerate(peaks) if p and min(abs(v - kk) for v in p) < band}
    # opposite pairs of rays both on the ring: the face's edge is there all round, the plate's side wall (when the
    # camera isn't side-on) shows on one side only and would make the plate look bigger
    def near(kk):
        hit = near1(kk)
        return [(i, v) for i, v in hit.items() if (i + K // 2) % K in hit]
    for kk in np.arange(1.25, 0.85, -0.0025):
        if len(near(kk)) >= 0.2 * K:
            for _ in range(3):   # re-centre on the cluster: the first scale to reach support is on its outer side
                kk = float(np.mean([v for _, v in near(kk)]))
            hit = near(kk)
            # semi-axes from the rim points themselves, centre fixed: cos²t / a² + sin²t / b² = 1 / r²
            ti = t[[i for i, _ in hit]]
            r = np.array([v for _, v in hit]) * rho[[i for i, _ in hit]]
            X = np.stack([np.cos(ti) ** 2, np.sin(ti) ** 2], 1)
            u, v = np.linalg.lstsq(X, 1 / r ** 2, rcond=None)[0]
            if u > 0 and v > 0:
                return 1 / np.sqrt(u), 1 / np.sqrt(v), len(hit) / K
            return a * kk, b * kk, len(hit) / K
    return a, b, 0.0


def body_confidence(L, bar, cm):
    """How far to trust one frame's joints: { vis, wristBarCm }.
    vis: mean visibility of the nearer side's shoulder, elbow, wrist, hip, knee and ankle (0..1).
    wristBarCm: nearer wrist to the bar centre; the hands hold the bar, so a value far from the lift's usual
      one means a misplaced wrist (or the hands are off the bar).
    How side-on the camera is comes from the plate (frames[i].axisRatio), not the joints: pose models guess a
    hidden far shoulder and hip almost on top of the near ones, so their spread can't see a turned camera."""
    sides = [[11, 13, 15, 23, 25, 27], [12, 14, 16, 24, 26, 28]]
    s = int(np.argmax([L[i, 3].mean() for i in sides]))
    vis = float(L[sides[s], 3].mean())
    wb = float(np.hypot(*(L[15 + s, :2] - bar)) * cm) if bar is not None else None
    return {"vis": round(vis, 2), "wristBarCm": None if wb is None else round(wb, 1)}


# ---------- the job ----------

def analyze(models, video, lift="snatch", facing=1, weight_kg=None, hint=None, progress=lambda stage, p: None, name=None):
    t_start = time.time()
    W, H, fps, times = probe(video)
    with tempfile.TemporaryDirectory(prefix="wlcoach-") as tmp:
        progress("Reading the video", 0.02)
        files = extract_frames(video, tmp)
        n = len(files)
        if len(times) != n:   # fall back to the nominal rate if the timestamps don't line up
            times = [i / fps for i in range(n)]
        start = int(hint["frame"]) if hint else 0
        start = min(max(start, 0), n - 1)
        first_rgb = cv2.cvtColor(cv2.imread(os.path.join(tmp, files[start])), cv2.COLOR_BGR2RGB)

        progress("Finding the plate", 0.08)
        if hint:
            r = float(hint["r"])
            box, found = [hint["x"] - r, hint["y"] - r, hint["x"] + r, hint["y"] + r], "hint"
        else:
            box, found = detect_plate(models, first_rgb), "owlv2"
            if box is None:
                raise RuntimeError("No plate found on the first frame. Mark the bar end in the app and try again.")

        progress("Tracking the plate", 0.12)
        masks = {}
        sam = models.sam
        # half precision on the Apple GPU: about 40 % faster, masks within 0.1 % of full precision
        amp = torch.autocast("mps", dtype=torch.float16) if DEVICE == "mps" else torch.autocast("cpu", enabled=False)
        with torch.inference_mode(), amp:
            state = sam.init_state(video_path=tmp, offload_video_to_cpu=True)
            sam.add_new_points_or_box(state, frame_idx=start, obj_id=1, box=np.array(box, dtype=np.float32))
            done = 0
            for reverse in (False, True):
                if reverse and start == 0:
                    break
                for f, _, logits in sam.propagate_in_video(state, start_frame_idx=start, reverse=reverse):
                    masks[f] = (logits[0, 0] > 0).cpu().numpy()
                    done += 1
                    progress("Tracking the plate", 0.12 + 0.8 * done / n)
            sam.reset_state(state)

        progress("Measuring each frame", 0.93)
        gray = lambda f: cv2.imread(os.path.join(tmp, files[f]), cv2.IMREAD_GRAYSCALE)
        # plate shape from the frames around the start, where the bar is still or slow
        ref = []
        for f in range(start, min(n, start + max(3, int(0.3 * fps)))):
            pts, area = outline(masks.get(f, np.zeros((H, W), bool)))
            if pts is not None and len(pts) >= 20:
                (cx, cy), (d1, d2), ang = cv2.fitEllipse(pts.astype(np.float32))
                # OpenCV's angle is of the first axis; turn the axes into horizontal (a) and vertical (b)
                hor = abs(np.cos(np.radians(ang)))
                a, b = (d1 / 2, d2 / 2) if hor > 0.5 else (d2 / 2, d1 / 2)
                ra, rb, share = rim_scale(gray(f), cx, cy, a, b)
                ref.append((a, b, area, ra, rb))
        if not ref:
            raise RuntimeError("The plate mask was empty on the first frames.")
        a0, b0, area0, ra0, rb0 = (float(np.median([r[i] for r in ref])) for i in range(5))
        # the mask's ellipse is for fitting mask outlines; the scale and shape come from the outer rubber.
        # With a start mark from the app, its radius sets the scale: the app fits the rim on the edges all round
        # (js/plate.js), which held up better on a thick plate filmed off-axis than this mask-based search.
        own_R, ratio = max(ra0, rb0), min(ra0, rb0) / max(ra0, rb0)
        R = float(hint["r"]) if hint else own_R

        points, frames_out, good, last = [], [], None, None
        for f in range(n):
            pts, area = outline(masks[f]) if f in masks else (None, 0)
            if pts is None or len(pts) < 20:
                points.append(None); frames_out.append(None); continue
            M = cv2.moments(masks[f].astype(np.uint8))
            guess = (M["m10"] / M["m00"], M["m01"] / M["m00"]) if M["m00"] else tuple(pts.mean(0))
            x, y, inl = fit_centre(pts, a0, b0, guess)
            size = min(area, area0) / max(area, area0)
            score = float(min(1.0, size * min(1.0, inl / 0.8)))
            # refine on the image itself: the plate's rings don't change when the mask grows onto a hand or
            # an arm. Not on a mostly hidden plate, where the mask's fit is all there is.
            how = "mask"
            if score >= 0.5:
                c = radial_centre(gray(f), x, y, R)
                if c is not None and np.hypot(c[0] - x, c[1] - y) < 0.15 * R:
                    x, y, how = c[0], c[1], "edges"
            # a jump is far from both the last good position and the previous frame: one wild frame flags only
            # itself, and after a long gap the track picks up again on the second frame back
            far = lambda p: p is not None and np.hypot(x - p[0], y - p[1]) > 0.6 * R
            jump = far(good) and (last is None or far(last))
            low = int(score < 0.5 or inl < 0.35 or jump)
            points.append([round(x, 3), round(y, 3), low])
            # how side-on the plate faces the camera on this frame (it also drops when the bar itself turns)
            (_, _), (d1, d2), _ = cv2.fitEllipse(pts.astype(np.float32))
            frames_out.append({"area": round(area), "score": round(score, 3), "inliers": round(inl, 3), "centre": how,
                               "axisRatio": round(float(min(d1, d2) / max(d1, d2)), 3)})
            last = (x, y)
            if not low:
                good = (x, y)

        # body: the lifter is the person holding the bar
        pose_frames = []
        if models.pose is not None:
            if hasattr(models.pose, "ts"):
                models.pose.ts = 0   # MediaPipe's video mode needs timestamps that only go up
            for f in range(n):
                progress("Tracking the body", 0.95 + 0.05 * f / n)
                p = points[f]
                rgb = cv2.cvtColor(cv2.imread(os.path.join(tmp, files[f])), cv2.COLOR_BGR2RGB)
                bar = None if p is None or p[2] else np.array(p[:2])
                L = models.pose(rgb, bar) if models.pose_kind != "mediapipe" else models.pose(rgb, bar, dt_ms=1000 * ((times[f] - times[f - 1]) if f else 1 / fps))
                pose_frames.append(L)
                if L is not None and frames_out[f] is not None:
                    frames_out[f]["body"] = body_confidence(L, bar, 22.5 / R)

    progress("Done", 1.0)
    return {
        "format": "wlcoach-result", "version": 1, "source": "engine",
        "producer": {"name": "wlcoach-engine", "version": VERSION, "device": DEVICE,
                     "models": {"detector": DETECTOR if found == "owlv2" else None, "tracker": models.sam2_name,
                                "pose": models.pose.name if models.pose is not None else None},
                     "seconds": round(time.time() - t_start, 1)},
        "video": {"name": name or os.path.basename(video), "W": W, "H": H, "fps": round(fps, 3), "frames": n},
        "lift": lift, "facing": facing, "weightKg": weight_kg,
        "plate": {"frame": start, "radiusPx": round(R, 2), "axisRatio": round(ratio, 3), "found": found,
                  "engineRadiusPx": round(own_R, 2)},
        "first": 0, "points": points, "times": [round(t, 5) for t in times], "frames": frames_out,
        **({"pose": {"first": 0, "model": models.pose.name,
                     "frames": [None if L is None else [round(float(v), 4 if k % 4 == 2 else 2) for k, v in enumerate(L.ravel())] for L in pose_frames]}}
           if models.pose is not None else {}),
    }
