# Dataset format (labelled lifts)

**Library → Dataset → Export labelled dataset** writes `weightlifting-coach-dataset-v1-<date>.json`: every saved lift that
has at least one label. Built by `js/dataset.js`. Nothing is trained; this is the raw material for a future
fault model, kept clean and versioned.

## Versioning

- `version`: the dataset layout (this document). Changes to field names or meanings bump it.
- `labelsVersion`: the layout of `labels`.
- `analysis`: the exact settings (`phases`, `smoothing`, `checks` from `js/config.js`) the series and
  findings were computed with. Every export re-computes everything from the raw measurements saved with each
  lift (bar positions, frame times, joints), with the current code, so two exports made with the same
  settings are directly comparable. Your labels are copied as they were saved.
- `findingsWhenSaved` keeps what the app said when the lift was saved, so a change in the checks can be
  measured against your labels.

## Layout

```jsonc
{
  "format": "wlcoach-dataset", "version": 1, "labelsVersion": 1, "exportedAt": "2026-10-21T09:00:00.000Z",
  "analysis": { "phases": {…}, "smoothing": {…}, "checks": {…} },
  "counts": { "lifts": 12, "labelledVerdicts": 40, "makes": 9, "misses": 3 },
  "lifts": [{
    "id": "…", "date": "2026-10-20", "lift": "clean", "weightKg": 60,
    "video": { "name": "IMG_4825.mov", "W": 1080, "H": 1920, "fps": 59.97 },
    "source": "engine",                 // engine or browser tracking
    "bodyModel": true,                  // joints were saved with the lift
    "scale": { "plateRadiusPx": 141.3, "cmPerPx": 0.15924, "plateWidthOverHeight": 0.91, "femurPx": 179.0 },
    "phases": { "liftoff": 202, "barAtKnee": 227, "fullExtension": 245, "peakSpeed": 242, "peak": 260,
                "received": 278, "catch": 298 },          // frame numbers; jerk lifts add jerkDipStart/Bottom/Lockout
    "summary": { "pullHeightCm": 91.6, "dropToCatchCm": 17.9, "rideDownCm": 13.2, "towardLifterCm": 10.8,
                 "awayFromLifterCm": 7.2, "peakSpeedMs": 1.74, "pullTimeS": 0.67, "turnoverTimeS": 0.6 },
    "findings": [{ "id": "close2", "status": "watch", "confidence": 0.63, "frame": 243 }, …],
    "findingsWhenSaved": [{ "id": "close2", "status": "watch", "confidence": 0.63 }, …],
    "labels": {
      "version": 1, "outcome": "make",  // make | miss | null
      "rating": 4,                      // 1–5 or null
      "verdicts": { "close2": "fault", "feet": "good" },   // your verdict per finding id: good | watch | fault | unsure
      "notes": "Bar swung out, felt it", "labelledAt": "2026-10-21T08:55:00.000Z"
    },
    "series": {                          // one entry per frame of the lift (set-up and drop left out); null where unknown
      "frame": [197, 198, …], "t": [-0.08, …],  // s from lift-off (negative before it)
      "barXcm": […],                     // + = away from the lifter, from where the bar left the floor (smoothed)
      "barYcm": […],                     // + = up, from the bar on the floor
      "vxMs": […], "vyMs": […],          // bar velocity, m/s (+ = away, + = up)
      "axMs2": […], "ayMs2": […],        // bar acceleration, m/s²
      "low": […],                        // 1 = position was a guess (bridged by the smoother), 0 = measured
      "hipDeg": […], "kneeDeg": […], "elbowDeg": […],   // nearer side, 180 = straight; null if not seen
      "backFromVerticalDeg": […]         // torso lean, + = shoulders ahead of the hips
    }
  }]
}
```

## Reading it

```python
import json, pandas as pd
ds = json.load(open("weightlifting-coach-dataset-v1-2026-10-21.json"))
lift = ds["lifts"][0]
df = pd.DataFrame(lift["series"])          # one row per frame
labels = lift["labels"]["verdicts"]        # {"close2": "fault", …}
```

Notes for later model work: series lengths differ between lifts (pad or resample on `t`); finding ids are
stable across versions; `confidence` and `low` say which inputs to trust; cm values use the plate's scale
(the body is ~1 m further from the camera, see docs/baseline.md), so body-derived quantities are better
taken from the angle columns or relative to `femurPx`.
