# Weightlifting Coach

Weightlifting Coach tracks the end of the barbell, and the lifter's body, through a snatch, clean or clean & jerk. It draws the bar's path against a vertical line and checks the lift for common technique faults. Everything runs in the browser, and videos never leave your device.

Based on [Bar Path](https://justinbischoff.github.io/bar-path/) by Justin Bischoff (MIT licence, see `LICENSE`).

**Full setup and user guide:** [docs/GUIDE.md](docs/GUIDE.md) (install, filming, using the app, the local engine and the AI coach, troubleshooting).

## How it works

1. **Load a lift.** Use a side-on video with the camera still and level with the bar. Pick the lift type.
2. **Mark the bar end.** When a video opens, the app looks for the plate on the first frame and marks it; press **Use this** to track, **Adjust** to move or resize the mark, or **Try another** for the next candidate. **Find the plate** runs it again on the current frame, using the body model to know the lifter's size, the floor and the hands. You can always click the centre of the sleeve yourself and drag to the plate rim. A 450 mm bumper plate sets the scale for measurements in centimetres; if the plate looks oval, the app warns that the camera isn't side-on.
3. **Track.** The bar end is followed frame by frame using normalised cross-correlation template matching in a Web Worker. Each match is refined to sub-pixel accuracy at full resolution from the plate's concentric edges, and a Kalman filter with a Rauch–Tung–Striebel smoother gives the path, velocity and acceleration using each frame's real presentation time. If the plate is lost, the tracker searches for it with a circle detector before asking you to mark it again.
4. **Check technique.** [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) finds the lifter's joints on each tracked frame. The app then checks:
   - **First pull:** shoulders over the bar, hips rising early, the bar drifting away, heels rising early.
   - **Second pull:** early arm bend, incomplete extension, the bar swinging away at the hips.
   - **Catch:** jumping forward or back, the bar landing off mid-foot.
   - **Jerk:** a forward dip, a forward drive, press-outs.

5. **Save and compare.** The Library tab saves each lift in this browser's IndexedDB. A save keeps:
   - the path, the readout and the findings
   - stills of the key positions (lift-off, bar at knee, extension, catch, jerk lockout)
   - the video too, if you choose to keep it.

   From the Library you can:
   - **Compare:** overlay up to five saved paths on one chart.
   - **Ghost:** lay a saved path over the current video.
   - **Back up:** export everything to a JSON file and import it on another device. Backups leave videos out.

   Nothing is uploaded.

The fault thresholds are starting points, not a coaching standard, and live in `js/config.js`. Every finding shows a confidence: how well the joints it needs were seen, how side-on the camera is (from the plate's shape), and how much of the bar path was measured rather than guessed. When the inputs can't support a verdict the check says so instead. One camera and a general body model can be several degrees off.

## Local engine (optional)

On a Mac with Apple silicon, `engine/start.sh` starts a local server (SAM 2.1 and OWLv2 on the GPU) at
`127.0.0.1:8765`. When it's running the app offers **High-quality analysis (local engine)** in step 3; the
result loads into the same views, saves and compares like any other lift. The video goes only to that local
server. See `engine/README.md`, and `docs/result-format.md` for the result format and API.

## Local AI coach (optional)

The **Coach** tab sends a short summary of the analysed lift (phases, bar figures, joint angles, findings with
their confidence, and your last saved lifts of the same type) to a language model on this computer, with the
coaching notes for the faults found (`knowledge/coaching.md`, **a draft that needs review by a qualified
coach**). It answers with one main issue, how it connects to the rest, at most two cues, a drill, evidence
citing frames (click to jump there) and what to watch next session; follow-up questions use the same lift.

Any OpenAI-compatible local server works. Default: LM Studio at `http://localhost:1234/v1` (turn on CORS in
its server settings). Ollama: `http://localhost:11434/v1`, for example

```sh
brew install ollama && ollama serve        # then, once: ollama pull qwen3:14b  (≈ 9.3 GB)
```

The answer is checked against the measurements: every number and frame it cites must be in the summary, at
most two cues, and its main issue can only be a finding the measurements back up (enforced through the JSON
schema). Anything that fails is flagged under the answer. It's a second opinion, not a coach.

## Offline and install

Weightlifting Coach is an installable web app. Use **Install app** in Chrome or Edge, or **Share → Add to Home Screen** in Safari. A service worker (`sw.js`) caches the app so it opens with no connection:
- **App files:** fetched from the network first so updates arrive, falling back to the cache when offline.
- **Pinned MediaPipe files and fonts:** served from the cache.
- **Pose model and runtime (about 21 MB):** cached the first time body tracking runs, so a first visit never downloads them unasked.

On iPhone, adding the app to the Home Screen also stops Safari from clearing saved lifts after a week without a visit.

## Run locally

It uses ES modules, so serve the folder instead of opening the file directly:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

There is no build step.

## Tests

```sh
npm test                          # unit tests for path.js and checks.js (Node's built-in runner)
node tests/make_synthetic.js      # generate lift videos with ground truth into samples/ (needs ffmpeg)
```

`tests/eval-detect.js` scores plate detection on the generated clips under Node.
`tests/eval-sample.js` scores the in-browser tracker on a generated clip, and `tests/eval-node.js` runs the
same tracker and smoother under Node for quick tuning (`node --import ./tests/dom-stub.js tests/eval-node.js`).
Results are in `docs/baseline.md`.

## Layout

| Path | What's in it |
| --- | --- |
| `index.html`, `css/app.css` | Page and styles |
| `js/app.js` | UI, transport, tracking and analysis orchestration |
| `js/sources.js` | Video loading, frame times and frame-rate detection, synthetic sample clip |
| `js/config.js` | Every threshold and tuning value, with units |
| `js/tracker.js` | Frame grabbing and the tracker worker client |
| `js/ncc.js`, `js/track-worker.js` | Template matching, centre refinement and the frame-to-frame tracker; the worker that runs it |
| `js/circles.js` | Gradient Hough circle search |
| `js/plate.js` | Automatic plate detection: sub-pixel rim fit (circle or ellipse), scoring, the body-model prior |
| `js/engine.js` | Client for the optional local engine |
| `js/coach.js`, `js/coach-ui.js` | Local AI coach: lift summary, prompt, answer checks; the Coach tab |
| `knowledge/coaching.md` | Coaching notes per fault for the AI coach (draft, needs a coach's review) |
| `knowledge/good-lift.md`, `js/reference.js` | What a good snatch, clean and jerk look like, with published elite ranges and sources; the readout's comparison |
| `engine/` | The local engine: FastAPI server, SAM 2.1 + OWLv2 pipeline, start script |
| `js/smooth.js` | Constant-acceleration Kalman filter + RTS smoother |
| `js/path.js` | Smoothed path, lift phases (lift-off, peak, catch, jerk), readout figures including velocity, timing and power |
| `js/pose.js` | MediaPipe loading, joint lookup and angles |
| `js/checks.js` | Technique fault checks |
| `js/draw.js` | Canvas overlay: path, body lines, measurement annotations, ghost path, comparison chart |
| `js/storage.js` | IndexedDB storage for saved lifts, images and videos; backup export and import |
| `js/library.js` | Save form, library list, opening saved lifts, ghost, compare |
| `js/pwa.js`, `sw.js`, `manifest.webmanifest`, `icons/` | Offline cache, install button, app manifest and icons |
| `vendor/mediapipe/` | Pinned copy of `@mediapipe/tasks-vision` 1.0.1 and the full pose model (Apache 2.0) |

## License

MIT for this project's code. MediaPipe is Apache 2.0; see `vendor/mediapipe/LICENSE`.
