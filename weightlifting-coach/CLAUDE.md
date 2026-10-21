# Weightlifting Coach: notes for Claude

Weightlifting video analysis: tracks the bar end, finds the plate, tracks the body, checks technique, and has an
optional local engine (SAM 2.1 / OWLv2 / RTMPose) and a local AI coach. Product name: **Weightlifting Coach**
(it began as a fork of justinbischoff/bar-path; the IndexedDB database keeps the name `bar-path` so saved lifts stay,
and old backups with `app: 'bar-path'` still import). "Bar path" in the UI means the bar's path, a feature.
User guide: `docs/GUIDE.md`. Accuracy history of every change: `docs/baseline.md`.

## Rules from the owner

- Most accurate analysis possible. The browser-only mode must keep working, with or without the engine.
- No build step for the web app (vanilla ES modules). Vendor new browser libraries like `vendor/mediapipe`.
- Nothing leaves the machine: no cloud APIs, no telemetry. The engine listens on 127.0.0.1 only.
- Ask before adding a heavy dependency or choosing between models when the trade-off isn't clear.
- Verify with numbers: the generated clips with ground truth and the real clips in `samples/`. Show the numbers.
- The owner has no coach: advice must be grounded in measurements and sourced references
  (`knowledge/good-lift.md`); `knowledge/coaching.md` is an unreviewed draft and says so.
- Not a git repository; work on the files directly.

## Commands

```sh
python3 -m http.server 8000 --bind 127.0.0.1      # the app at http://localhost:8000
npm test                                           # unit tests (Node's runner, no install)
node tests/make_synthetic.js [clip]                # generated clips + *.truth.json into samples/
node --import ./tests/dom-stub.js tests/eval-node.js [clip]      # browser tracker vs truth, under Node
node --import ./tests/dom-stub.js tests/eval-detect.js [clip]    # plate detection vs truth
node --import ./tests/dom-stub.js tests/track-video.js samples/x.mov X Y R [frame] [lift] [facing]   # any video
node --import ./tests/dom-stub.js tests/compare-results.js a.json b.json        # two result files, no truth
engine/start.sh                                    # local engine on 127.0.0.1:8765
engine/.venv/bin/python engine/eval.py             # engine on the generated clips
node --import ./tests/dom-stub.js tests/score-result.js                          # score engine results
node --import ./tests/dom-stub.js tests/coach-run.js result.json [pose.json] [model]   # AI coach (Ollama)
```

In the browser, `tests/eval-sample.js` runs the real app on a generated clip (instructions in the file).

## Layout

- `js/config.js`: every threshold and tuning value, with units. Change numbers here, not in the code.
- Pure, Node-testable modules (no DOM): `path.js` (smoothed path, phases, readout), `smooth.js` (Kalman + RTS),
  `ncc.js` (tracker), `circles.js`, `plate.js` (plate finder), `checks.js`, `reference.js`, `coach.js`,
  `dataset.js`. DOM modules: `app.js`, `library.js`, `coach-ui.js`, `tracker.js`, `sources.js`, `draw.js`.
- `state.js` holds the shared state `S`. `tests/dom-stub.js` lets modules that touch `document` load in Node.
- `engine/`: FastAPI + `pipeline.py` (SAM 2.1 masks → edge-refined centres) + `pose.py` (RTMPose, MediaPipe).
  Result format and API: `docs/result-format.md`. The engine measures; the web app analyses.
- `tests/lift.js` builds synthetic lifts (bar path + 33 landmarks) with options for each fault.

## Pitfalls already hit (don't reintroduce)

- **Holes in arrays:** untracked frames are holes in `S.points` / `S.pose`, and `Array.prototype.map` skips
  holes. Use `Array.from(arr, fn)` when building per-frame arrays (see `smoothXY`, `finishPose`).
- **Hidden page:** `requestVideoFrameCallback` doesn't fire when the page isn't drawn, so frame times fall back to
  nominal and frame-rate detection to playback timing (which can read nonsense). Keep the Browser pane visible
  (`show_pane`) when testing timing; check `document.hidden`.
- **Stale modules:** `python -m http.server` sends no cache headers. `sw.js` revalidates app files; after editing,
  bump `SHELL` in `sw.js` and add new files to its `APP` list. In tests, `fetch(f, { cache: 'reload' })` first.
- **Scale:** the plate sets cm. Thick plates filmed off-axis show their side wall; the rim is taken only where it
  shows on both sides of the centre. The lifter is ~1 m behind the near plate, so body sizes in plate-scale cm
  are 20–35 % small: judge body distances in femur lengths.
- **Occlusion:** the near plate hides the feet at the start, the wrist in the pull and the hip at extension, and
  pose models still report them as seen. `checks.js` down-weights joints inside the plate's disc.
- **Camera angle:** the plate's width ÷ height (`S.axisRatio`) drives the side-on confidence; browser and engine
  estimates differ by a few hundredths on real video.
- **The terminal tool rejects the "å" in this path;** start long-running processes with background Bash.
- **The coach's main issue** is constrained by the JSON schema (`schemaFor`); prompt rules alone were ignored.
