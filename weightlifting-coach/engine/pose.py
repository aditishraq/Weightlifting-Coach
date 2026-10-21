"""2D body tracking for the engine. Every model's output is mapped to MediaPipe's 33-point layout, which is
what the web app reads (js/pose.js SIDE), so the body overlay and the checks work unchanged.

Frames are RGB numpy arrays; results are lists (one per frame) of 33 [x, y, z, visibility] in frame px,
or None where no lifter was found."""
import os

import numpy as np

HERE = os.path.dirname(__file__)
os.environ.setdefault("TORCH_HOME", os.path.join(HERE, "models", "torch"))   # rtmlib's download folder

# Halpe-26 (RTMPose body with feet) → MediaPipe 33. Points MediaPipe has and Halpe doesn't (eye corners, mouth,
# fingers) are filled from the nearest Halpe point with visibility 0, so nothing reads them as measured.
HALPE_TO_MP = {0: 0, 2: 1, 5: 2, 7: 3, 8: 4, 11: 5, 12: 6, 13: 7, 14: 8, 15: 9, 16: 10, 23: 11, 24: 12, 25: 13,
               26: 14, 27: 15, 28: 16, 29: 24, 30: 25, 31: 20, 32: 21}
FILL = {1: 1, 3: 1, 4: 2, 6: 2, 9: 0, 10: 0, 17: 9, 19: 9, 21: 9, 18: 10, 20: 10, 22: 10}


def halpe_to_mp(kp, sc):
    out = np.zeros((33, 4))
    for m, h in HALPE_TO_MP.items():
        out[m] = [kp[h, 0], kp[h, 1], 0.0, min(1.0, float(sc[h]))]
    for m, h in FILL.items():
        out[m] = [kp[h, 0], kp[h, 1], 0.0, 0.0]
    return out


def pick_lifter(people, bar):
    """Index of the person whose nearer wrist is closest to the bar (the lifter holds it); else the biggest."""
    if not people:
        return None
    if bar is not None:
        d = [min(np.hypot(*(p[i, :2] - bar)) for i in (15, 16)) for p in people]
        return int(np.argmin(d))
    size = [np.ptp(p[:, 0]) * np.ptp(p[:, 1]) for p in people]
    return int(np.argmax(size))


class RTMPose:
    """RTMPose-x body with feet (Halpe-26) through ONNX Runtime. The pose network runs on CoreML (Apple GPU /
    Neural Engine, ~17 ms) when it can; the YOLOX-x person detector doesn't convert to CoreML and takes ~0.5 s on
    the CPU, so it only runs on the first frame, when the lifter is lost, and once a second. In between, the box
    comes from the previous frame's joints (as rtmlib's PoseTracker does)."""
    name = "rtmpose-x halpe26 (rtmlib, performance)"

    def __init__(self, mode="performance", device="mps", redetect=60):
        from rtmlib import YOLOX, RTMPose as Net
        from rtmlib.tools.solution.body_with_feet import BodyWithFeet
        cfg = BodyWithFeet.MODE[mode]
        self.det = YOLOX(cfg["det"], model_input_size=cfg["det_input_size"], backend="onnxruntime", device="cpu")
        try:
            self.net = Net(cfg["pose"], model_input_size=cfg["pose_input_size"], backend="onnxruntime", device=device)
            self.net(np.zeros((256, 192, 3), np.uint8), bboxes=[[0, 0, 192, 256]])   # CoreML can fail on first use
        except Exception:
            self.net = Net(cfg["pose"], model_input_size=cfg["pose_input_size"], backend="onnxruntime", device="cpu")
        self.redetect, self.n, self.box = redetect, 0, None

    def __call__(self, rgb, bar=None):
        bgr = np.ascontiguousarray(rgb[:, :, ::-1])     # rtmlib wants BGR
        H, W = bgr.shape[:2]
        self.n += 1
        if self.box is None or self.n % self.redetect == 0:
            boxes = list(self.det(bgr))
            if not len(boxes):
                self.box = None
                return None
        else:
            boxes = [self.box]
        kps, scs = self.net(bgr, bboxes=boxes)
        people = [halpe_to_mp(k, s) for k, s in zip(kps, scs)]
        i = pick_lifter(people, bar)
        if i is None:
            self.box = None
            return None
        L = people[i]
        good = L[[11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28], 3]
        if good.mean() < 0.3:
            self.box = None    # lost: detect again next frame
            return L
        # next frame's box: these joints' extent, widened by a quarter, and taking in the bar
        pts = L[L[:, 3] > 0.3, :2]
        if bar is not None:
            pts = np.vstack([pts, bar])
        (x0, y0), (x1, y1) = pts.min(0), pts.max(0)
        mx, my = 0.25 * (x1 - x0) + 20, 0.25 * (y1 - y0) + 20
        self.box = [max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my)]
        return L


class MediaPipePose:
    """The same MediaPipe model the browser runs (vendor/mediapipe/pose_landmarker_full.task)."""
    name = "mediapipe pose_landmarker_full"

    def __init__(self):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
        task = os.path.join(HERE, "..", "vendor", "mediapipe", "pose_landmarker_full.task")
        self.mp = mp
        self.lm = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=task), running_mode=vision.RunningMode.VIDEO, num_poses=1,
            min_pose_detection_confidence=0.4, min_pose_presence_confidence=0.4, min_tracking_confidence=0.4))
        self.ts = 0

    def __call__(self, rgb, bar=None, dt_ms=17):
        H, W = rgb.shape[:2]
        self.ts += max(1, int(dt_ms))
        r = self.lm.detect_for_video(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)), self.ts)
        if not r.pose_landmarks:
            return None
        return np.array([[p.x * W, p.y * H, p.z, p.visibility if p.visibility is not None else 1.0] for p in r.pose_landmarks[0]])
