# Weightlifting Coach: setup and user guide

Everything needed to install, run and use the app on a Mac with Apple silicon. The app works on its own in a
browser; the local engine and the AI coach are optional extras that run on the same computer. No video or
data leaves the machine.

| Part | What it does | Needs |
| --- | --- | --- |
| Web app | Tracks the bar, finds the plate, body tracking (MediaPipe), checks, library | A browser (Chrome, Edge, Safari) and a local web server |
| Local engine (`engine/`) | Better tracking (SAM 2.1), plate finding (OWLv2), body tracking (RTMPose) | Python 3.12, ~2.7 GB of models and packages |
| AI coach | Explains the analysis, suggests cues and drills | Ollama or LM Studio and a ~9 GB model |

## 1. Install

```sh
# command-line tools (once)
xcode-select --install          # if git/compilers are missing
brew install python@3.12 ffmpeg node ollama
```

Get the project folder (`bar-path-main`) onto the Mac. All commands below run from inside it.

## 2. Run the web app

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open http://localhost:8000. The app has no build step. It opens with a built-in sample clip already tracked.

Keep the browser window **visible while tracking**: the browser only reports exact frame times and the
frame rate for a page it is drawing. In a hidden or minimised window the app falls back to estimates (it
says so under Frame rate), which is slower and less exact.

## 3. Optional: start the local engine

```sh
engine/start.sh            # first run: creates engine/.venv and downloads the models (needs internet once)
engine/start.sh --large    # SAM 2.1 large instead of base-plus (slower)
```

Leave it running in its own terminal. Reload the app: step 3 now shows **High-quality analysis (local
engine)**. A 13 s phone clip takes about 8 minutes (plate tracking ~0.5 s per frame, body tracking ~60 ms).
Details: `engine/README.md`.

## 4. Optional: start the AI coach

```sh
ollama serve               # leave running
ollama pull qwen3:14b      # once, ≈ 9.3 GB
```

In the app's **Coach** tab set the endpoint to `http://localhost:11434/v1` and press **Connect**. (LM Studio
works too: start its server on port 1234 and turn on CORS in its server settings; that is the default
endpoint.) The engine and the coach don't need to run at the same time; running them one after the other
leaves more memory for each.

## 5. Film a lift

The camera position decides how much of the analysis can be trusted. In order of importance:

1. **Exactly side-on to the bar.** The camera looks along the bar's direction of travel at 90° to the bar.
   The app measures this from the plate's shape: below 0.92 (width ÷ height) it warns, and checks that
   compare the bar with the body are skipped. Aim for 0.97 or more.
2. **Lens at about hip height, level.** Not looking down at the bar.
3. **Far away and zoomed in.** 5–8 m away with 2× zoom beats 3 m at 1×. The near plate is about a metre
   closer to the camera than the lifter's body; from further away that difference matters less, so
   bar-to-body distances and joint angles get more accurate.
4. **Tripod, nothing moves.** No panning, no zoom changes, lock focus and exposure (tap and hold on iPhone).
5. **60 fps or more, bright light.** 120 or 240 fps slow motion is better for speed and timing; a bright
   room keeps the shutter fast and the plate sharp.
6. **The whole lift in the frame.** Feet to bar overhead, with some floor in front of the bar. Portrait
   works well for a single lifter.
7. **A standard 450 mm bumper on the near side**, ideally a coloured, thin competition-style plate. Thick
   training plates show their side wall when the camera is even slightly off side-on, which makes the scale
   less certain. Nothing between the camera and the bar.

What can't be helped from the side: the near plate hides the feet at the start and the hip at full
extension. The app lowers the confidence of checks that rely on hidden joints.

## 6. Analyse a lift

1. **Load:** Choose video (or drop the file). Pick the lift type. Check the detected frame rate.
2. **Mark:** the app finds the plate on the first frame. **Use this** tracks straight away; **Adjust** lets
   you click the sleeve centre and drag to the rim; **Try another** shows the next candidate. If the lift
   starts later in the clip, scrub to that frame and press **Find the plate on frame N**.
3. **Track** (browser) or **High-quality analysis** (engine).
4. **Technique tab:** press **Analyse technique** for the body model (not needed after an engine run, which
   includes the body). Enter the bar weight on the Bar path tab to get power.
5. **Coach tab:** **Ask the coach**, then ask follow-up questions. Click a frame in the evidence to see it.
6. **Library tab:** save the lift (optionally with the video). Compare up to five saved paths, or ghost a
   saved path over the current video. Export a backup now and then.
7. **Label it** (open the saved lift in the Library): make or miss, a 1–5 rating, your own verdict on each
   finding, notes. Labelled lifts go into **Export labelled dataset** (format: `docs/dataset-format.md`), the
   material for tracking your own patterns and, later, a fault model trained on your lifts.

## 7. Reading the results

- **The lift only:** the path, the saved path, the video export and the dataset cover the lift itself, from the
  last frame with the bar on the floor to where the bar starts to fall after the recovery. The set-up before it
  and the drop after it are tracked but not shown ("lift f 191–441" under Frames).
- **Readout:** pull height, drop to catch (top of the pull to where the bar is caught) and ride down (how far
  it sinks with you after that), horizontal movement from where the bar left the floor, peak bar speed,
  pull and turnover times, power.
- **Findings:** good / watch / fault, each with a **confidence**: how well the joints it needs were seen,
  how side-on the camera was, and how much of the bar path was measured rather than guessed. Below 35 % a
  check says **n/a** and why. Treat anything under ~60 % as a hint to re-film, not a verdict.
- **Compared with elite lifts** (under the readout, for the snatch and the jerk): your sweep back, loop at
  the hips, catch position, pull height, drop, catch height and bar speed next to published ranges from elite
  competition lifts, marked within / below / above one standard deviation. These describe elite lifts, not
  targets: lighter lifts are faster and higher, taller lifters pull higher, and elite lifters succeed with
  every bar path type. The positions, numbers and sources are in `knowledge/good-lift.md`. No published
  ranges were found for the clean's bar path, so the clean shows none.
- **Coach:** a second opinion grounded in the measurements. Red text under an answer means it cited
  something that wasn't measured; ignore that part.

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Frame rate shows 30 for a 60 fps clip | Keep the window visible while opening the video, or set the rate by hand. |
| Changes to the app don't show | Hard-reload (Cmd-Shift-R); the offline cache revalidates on each load. |
| No engine button | Is `engine/start.sh` running? Check http://127.0.0.1:8765/health. |
| Coach: "No model server" | Start `ollama serve` (or LM Studio's server with CORS on) and press Connect. |
| Plate found in the wrong place | **Try another**, or **Adjust** and mark it by hand. |
| Lost the bar mid-lift | Go to that frame, click the bar end, track again from there. |
| Many n/a findings | Film more side-on, from further away, in better light. |

## 9. For development

```sh
npm test                                                   # unit tests (Node's built-in runner, no install)
node tests/make_synthetic.js                               # generate test clips with ground truth into samples/
node --import ./tests/dom-stub.js tests/eval-node.js       # score the tracker on them
node --import ./tests/dom-stub.js tests/eval-detect.js     # score plate detection
engine/.venv/bin/python engine/eval.py                     # run the engine on them
node --import ./tests/dom-stub.js tests/score-result.js    # score engine results
```

- Thresholds and tuning values: `js/config.js` (with units).
- Accuracy history, every phase: `docs/baseline.md`.
- Engine result format and API: `docs/result-format.md`.
- Coaching notes the AI coach uses: `knowledge/coaching.md`.
