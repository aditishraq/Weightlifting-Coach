# Result format

What the local engine (`engine/`) returns for a lift, and what the web app loads. Version 1.

## Design

The engine **measures** and the web app **analyses**. The engine returns per-frame bar positions, frame
times and the plate scale (later also joints). The web app loads them into the same state a browser track
fills (`S.points`, `S.times`, `S.radius`) and runs its usual smoother, phases, readout, checks, saving,
Compare and Ghost on them. That way both modes give the same kind of result, analysed by the same code. A
saved lift stays a saved lift whichever mode tracked it.

The arrays use the same layout as a saved lift in the library (`js/library.js` `buildRecord`): they start
at frame `first`, and `null` marks a frame with no measurement.

## Object

```jsonc
{
  "format": "wlcoach-result",
  "version": 1,
  "source": "engine",                  // "engine" or "browser"
  "producer": {                        // who made it and how
    "name": "wlcoach-engine", "version": "0.1.0",
    "device": "mps",                   // mps | cpu
    "models": { "detector": "google/owlv2-base-patch16-ensemble", "tracker": "sam2.1_hiera_base_plus" },
    "seconds": 41.7                    // wall time for the job
  },
  "video": { "name": "lift.mp4", "W": 720, "H": 1280, "fps": 60, "frames": 235 },
  "lift": "snatch",                    // snatch | clean | cj, as sent
  "facing": 1,                         // 1 = lifter faces right (+x is away from the lifter), -1 = left
  "weightKg": 80,                      // as sent, or null

  "plate": {
    "frame": 0,                        // frame the plate was found on
    "radiusPx": 112.6,                 // outer radius (larger semi-axis) in px; sets the scale: 22.5 cm / radiusPx
    "axisRatio": 0.90,                 // smaller / larger semi-axis; below 0.92 the camera isn't side-on
    "found": "owlv2",                  // owlv2 | hint (the start mark sent with the request)
    "engineRadiusPx": 113.1            // the engine's own rim measurement; radiusPx is the hint's when one was sent
  },

  "first": 0,                          // index of the first frame in the arrays below
  "points": [[400.1, 1087.6, 0], null, ...],   // bar-end centre [x, y, low] in frame px; low = 1 for low confidence
  "times": [0, 0.01667, ...],          // presentation time of each frame in s (null if unknown)
  "frames": [                          // optional per-frame detail, same indexing; null where untracked
    { "area": 39410, "score": 0.98, "inliers": 0.97, "centre": "edges", "axisRatio": 0.93,
      "body": { "vis": 0.91, "wristBarCm": 11.2 } }     // body: when joints were found on this frame
  ],
  "pose": {                            // optional: the lifter's joints, MediaPipe's 33-point layout
    "first": 0, "model": "rtmpose-x halpe26 (rtmlib, performance)",
    "frames": [[x, y, z, v, x, y, z, v, ...], null, ...]   // 33 × [x px, y px, z, visibility 0..1] per frame
  }
}
```

### Field rules

- `points[i]` and `times[i]` describe frame `first + i`.
- Coordinates are in the full-resolution frame's pixels, origin top-left, y down.
- `low = 1` means the position is a guess (the plate was mostly hidden, or the mask shrank or jumped). The
  smoother treats it as missing and bridges it, the same as a low-confidence browser frame.
- `frames[i].score` is 0..1: how much the frame's mask looks like the plate on the start frame (area and shape).
- `frames[i].centre` says where the position came from: `edges` (the plate's rings, radial symmetry) or `mask`
  (SAM's outline only, when the plate is partly hidden).
- `pose` uses the library's layout, so the web app loads it like a saved lift's joints. Points a model doesn't
  have (MediaPipe's eye corners, mouth and fingers for RTMPose) carry visibility 0. `z` is 0 for 2D models.
- `frames[i].body`: `vis` = mean visibility of the nearer side's shoulder, elbow, wrist, hip, knee and ankle;
  `wristBarCm` = nearer wrist to the bar centre (the hands hold the bar, so a value far from the lift's usual
  one means a misplaced wrist; with the camera off side-on it is never 0, as the hands are further away).
- `frames[i].axisRatio`: width ÷ height of the plate's mask on that frame, the per-frame side-on check (it
  reads a little high because the mask includes a thick plate's side wall). The joints can't tell: pose models
  put a hidden far shoulder and hip almost on top of the near ones.

## Job API (engine)

| Method | Path | Body / reply |
| --- | --- | --- |
| GET | `/health` | `{ "ok": true, "version", "device", "models": { "detector", "tracker", "ready" } }` |
| POST | `/analyze` | multipart: `video` (file), `lift`, `facing`, `weightKg` (optional), `hint` (optional JSON `{ "frame", "x", "y", "r" }`) → `{ "job": "<id>" }` |
| GET | `/jobs/{id}` | `{ "status": "queued" \| "running" \| "done" \| "error", "stage", "progress" (0..1), "result"?, "error"? }` |

The engine listens on 127.0.0.1 only and accepts requests from pages served from localhost. `POST /analyze`
needs the header `X-WL-Coach: 1`, so a page from anywhere else can't start a job with a plain form post. Videos are
written to a temporary folder for the job and deleted when it finishes.
