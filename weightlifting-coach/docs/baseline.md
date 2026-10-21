# Accuracy

Phase 0 is the unmodified upstream app; every later phase must match or beat it. Phase 1 results are at the end.

## Built-in sample clip (`demoSource` in js/sources.js)

84 frames, 30 fps, 720×960, rendered plate with known trajectory. Clean render, no blur or noise, so this
is a best case for NCC. Measured with `tests/demo-baseline.js` (paste into the console after the clip tracks).
Velocity is the frame-to-frame difference of bar height, in m/s.

| Metric | Ground truth | Raw track | Smoothed (default, [1,2,3,2,1]) |
| --- | --- | --- | --- |
| Position RMSE | – | 0.21 cm | 0.28 cm |
| Position max error | – | 0.62 cm | 0.68 cm |
| Pull height | 102.15 cm | 102.35 cm (+0.20) | 101.59 cm (−0.56) |
| Drop to catch | 15.60 cm | 15.58 cm (−0.02) | 14.80 cm (−0.80) |
| Pull peak frame | 50 | 50 | 50 |
| Catch frame | 70 | 70 | 71 |
| Peak vertical velocity | 1.285 m/s @ f39 | 1.286 m/s @ f40 | 1.259 m/s @ f39 (−2.0 %) |

The moving average clips the peak and the catch, so on clean data it is worse than no smoothing.

## Generated lift videos (`tests/make_synthetic.js`)

`node tests/make_synthetic.js` writes three H.264 clips plus `*.truth.json` (bar centre per frame in px and m,
true velocity, key frames, pull height, drop, peak velocity) into `samples/`. 720×1280, side-on, 450 mm plate
(112.5 px radius), lifter facing right. The plate rotates during the lift and the lifter moves behind it.

| Clip | Lift | fps | Noise σ | Shutter | Plate axis ratio | Flicker | Shake | CRF |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| snatch30occl (added in Phase 1) | snatch | 30 | 4 | 0.6 | 1.00 | 0 | 0.3 px | 23 |
| snatch30gym (added in Phase 2) | snatch | 30 | 4 | 0.6 | 1.00 | 0 | 0.3 px | 23 |
| snatch60 | snatch | 60 | 2.5 | 0.5 | 1.00 | 0 | 0 | 18 |
| snatch30hard | snatch | 30 | 7 | 0.9 | 0.90 | ±6 % | 0.6 px | 28 |
| cj30 | clean & jerk | 30 | 4 | 0.6 | 0.97 | ±2 % | 0.3 px | 23 |

snatch30occl has someone walking between the camera and the bar from 0.75 s to 1.35 s, hiding the plate
for about five frames in the first pull. snatch30gym has three spare plates in view: a yellow one on the floor
behind the lifter (95 px), a red one on the wall (88 px) and a green one (60 px).

Truth: snatch pull height 100 cm, drop 20 cm, peak vertical velocity 1.905 m/s. Clean & jerk pull height 86 cm,
drop 14 cm, peak velocity 1.601 m/s, jerk dip 12 cm.

Measured with `tests/eval-sample.js` (instructions at the top of the file). It places the start mark exactly
on the true centre with the true radius, then presses the app's own Track button. Errors are app − truth.

| | snatch60 raw | snatch60 smoothed | snatch30hard raw | snatch30hard smoothed | cj30 raw | cj30 smoothed |
| --- | --- | --- | --- | --- | --- | --- |
| Frames tracked | 235/235 | | 117/118 | | 168/169 | |
| Position RMSE | 0.56 cm | 0.57 cm | 0.97 cm | 1.07 cm | 0.53 cm | 0.69 cm |
| Position max error | 1.02 cm | 1.07 cm | 1.82 cm | 2.28 cm | 0.77 cm | 2.45 cm |
| Pull height | −0.25 cm | −0.78 cm | −0.29 cm | −2.18 cm | −0.64 cm | −2.19 cm |
| Drop to catch | +0.05 cm | −0.61 cm | +0.59 cm | −1.41 cm | −0.62 cm | −2.22 cm |
| Peak vertical velocity | +0.9 % | −4.2 % | −4.2 % | −6.9 % | −0.5 % | −8.9 % |
| Peak velocity timing (frames) | −6.0 | 0.0 | −0.75 | −0.75 | +0.1 | −0.9 |
| Lift-off frame | 0 | 0 | +1 | 0 | +1 | 0 |
| Pull peak frame | 0 | 0 | 0 | 0 | 0 | 0 |
| Catch frame | 0 | +2 | +8 | +14 | +10 | +5 |
| Jerk dip bottom frame | | | | | −1 | −1 |

What this shows about the current pipeline:
- **A fixed bias of up to ~2 px.** Tracking runs on a ¼-scale image (`s = 28 / radius`), and the template is cut
  at the rounded scaled pixel, so the template centre sits up to 0.5 scaled px (2 px, 0.4 cm here) from the
  mark. The error is already 0.35 cm while the bar is still on the floor, and it stays for the whole lift.
- **The template drifts** as it adapts to the rotating plate: about −0.7 cm in x by the end of the snatch recovery.
- **Smoothing hurts every figure:** it clips the peak and the catch and cuts peak velocity by 4–9 %.
- **Raw frame differences are noisy:** on the 60 fps clip the highest single-frame velocity lands 6 frames
  (0.1 s) early.
- **The catch frame is ambiguous** when the bar sits still in the bottom position: the lowest point can fall
  anywhere in the hold (+8 to +14 frames at 30 fps). The drop distance itself is still right.
- The last frame of 30 fps clips is never tracked (`N = floor(duration × fps)`).
- Pose is not scored here. The drawn lifter is a silhouette, not a person, so it is not a fair test for
  MediaPipe. Body checks have unit tests on synthetic landmarks instead (`tests/checks.test.js`).

## Phase 1 (browser pipeline)

Same measurement in the browser (`tests/eval-sample.js`, smoothing on, which is the default), with real frame
times from `requestVideoFrameCallback` and the tracker in a Worker. Errors are app − truth; Phase 0 in brackets.
Two runs gave identical numbers.

| | snatch60 | snatch30hard | cj30 | snatch30occl |
| --- | --- | --- | --- | --- |
| Detected frame rate | 60 | 30 | 30 | 30 |
| Frames tracked | 235/235 | 118/118 (117) | 169/169 (168) | 118/118, 5 bridged |
| Position RMSE | **0.06 cm** (0.57) | **0.23 cm** (1.07) | **0.03 cm** (0.69) | 0.22 cm |
| Position max error | 0.16 cm (1.07) | 0.63 cm (2.28) | 0.13 cm (2.45) | 1.00 cm |
| Pull height | −0.03 cm (−0.78) | +0.10 cm (−2.18) | −0.39 cm (−2.19) | 0.00 cm |
| Drop to catch | +0.07 cm (−0.61) | +0.31 cm (−1.41) | −0.34 cm (−2.22) | +0.12 cm |
| Peak vertical velocity | −0.8 % (−4.2) | −0.3 % (−6.9) | −3.5 % (−8.9) | −1.8 % |
| Velocity RMSE, lift-off to catch | 0.028 m/s | 0.065 m/s | 0.026 m/s | 0.055 m/s |
| Pull time (lift-off → peak velocity) | +8 ms | −8 ms | +19 ms | −8 ms |
| Turnover time (peak velocity → catch) | −8 ms | +8 ms | −19 ms | +8 ms |
| Lift-off / pull peak / catch frame | 0 / 0 / 0 (0 / 0 / +2) | 0 / 0 / 0 (0 / 0 / +14) | 0 / −1 / 0 (0 / 0 / +5) | 0 / 0 / 0 |
| Frame time error (max) | 0 ms | 0 ms | 0 ms | 0 ms |
| Tracking time | 8.5 s (6.5) | 3.0 s (1.9) | 3.2 s (2.0) | 2.6 s |

Built-in sample clip: position RMSE 0.13 cm (0.28), pull height +0.24 cm (−0.56), drop +0.19 cm (−0.80),
peak velocity +0.3 % (−2.0 %).

Power, checked on snatch30occl with 80 kg: peak 2263 W vs 2220 W true (+2 %), mean pull power 915 W vs
921 W true (−0.7 %).

What made the difference, in order of effect:
1. **Full-resolution centre refinement** (`radialCenter` in js/ncc.js): after the NCC match, the plate centre
   is the least-squares point nearest every edge-gradient line that points radially (rim, face rings, hub).
   It doesn't care about rotation and doesn't drift. The template adapts at the refined position, so the
   template-update drift is gone.
2. **Kalman + RTS smoother** instead of the moving average: no more clipped peaks and catches.
3. **Sub-pixel template cut and per-axis working scale**: removes the fixed offset of up to 2 px.
4. **Physical motion gate** (½·a·t² around the constant-velocity prediction, a = 50 m/s²) plus a stricter
   score when leaving a gap: without it, the half-hidden plate in snatch30occl jumped 11 cm onto the passer-by.
5. **Catch frame = first frame at the bottom** rather than the lowest point of a still hold.

Known limits:
- The cj30 velocity spike is one frame wide at 30 fps; no smoother can recover it fully (−3.5 %).
- Tracking is 30–50 % slower than Phase 0. The time goes on seeking, waiting for the frame callback and the
  full-resolution crop, not on matching: summed-area tables only remove the Σv and Σv² sums, and the cross
  term still dominates (0.9–1.3× on the matcher alone, ≤ 2.5 ms per frame either way).
- The circle re-find never had to step in on these clips (the gated NCC recovered by itself); it is
  covered by unit tests in tests/ncc.test.js.
- The smoother settings are tuned on these generated clips. Joint smoothing uses the same bandwidth but has
  not been checked against real pose data.
- If the page is hidden or not on screen, frame callbacks don't fire; frames then fall back to nominal
  times and frame-rate detection to playback timing (less reliable).

## Phase 2 (automatic plate detection)

Detection on the first frame. Truth: plate centre and the 112.5 px outer radius. Errors are found − true.

Under Node (`tests/eval-detect.js`), three ways per clip: no body model; a prior from the true joints;
the same with joint noise of σ = 2 % of the lifter's height (about MediaPipe's error).

| | no body model | true joints | noisy joints |
| --- | --- | --- | --- |
| snatch60 | 0.14 px, +0.31 % | 0.14 px, +0.31 % | 0.81 px, +0.37 % |
| snatch30hard (oval 0.90) | 0.71 px, +0.13 %, ratio 0.901 | 0.71 px, +0.13 %, 0.901 | 0.71 px, +0.13 %, 0.901 |
| cj30 (oval 0.97) | 0.23 px, +0.45 %, ratio 0.970 | same | same |
| snatch30occl | 0.29 px, +0.25 % | 0.36 px, +0.26 % | 0.36 px, +0.26 % |
| snatch30gym (spare plates) | 0.90 px, +0.54 % | 0.79 px, +0.63 % | 0.90 px, +0.54 % |

Detection takes 50–200 ms per frame.

In the browser, end to end: open the clip (the finder runs by itself), press **Use this**, let it track.
No hand-placed mark anywhere.

| | Centre | Radius | Oval warning | Tracked | Position RMSE | Pull height | Drop | Peak velocity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| snatch60 | 0.05 px | +0.27 % | no | 235/235 | 0.06 cm | −0.29 cm | +0.03 cm | −1.1 % |
| snatch30hard | 0.46 px | +0.09 % | **yes** (0.90) | 118/118 | 0.22 cm | +0.10 cm | +0.29 cm | −0.4 % |
| cj30 | 0.24 px | +0.44 % | no (0.97) | 169/169 | 0.03 cm | −0.73 cm | −0.40 cm | −3.9 % |
| snatch30occl | 0.45 px | +0.36 % | no | 118/118 | 0.22 cm | −0.26 cm | +0.05 cm | −2.1 % |
| snatch30gym | 1.01 px | +0.44 % | no | 118/118 | 0.16 cm | −0.40 cm | 0.00 cm | −1.9 % |

These match Phase 1 (which used the exact true mark) to within the radius error. The plate radius sets the
cm scale, so +0.3 % in radius reads 100 cm as 99.7 cm.

How it works (js/plate.js):
1. Shrink the frame to 320 px and run the gradient Hough search (in the body-model box and radius range when
   there is one). Concentric circles are kept apart, so a plate's hub can't hide its rim.
2. For each candidate, at full resolution: the centre from the radial symmetry of all the plate's rings;
   up to six edges on each of 96 rays out to 1.6 r; the best-supported ring by RANSAC over the two semi-axes
   with the centre fixed; Tukey reweighting; then the largest concentric copy of that ring the edges support,
   which is the outer rubber even when only part of it shows against dark clothing.
3. Score: how much of the outline is there, and, when known, radius vs 0.13 × the lifter's height (from
   ankle→knee→hip→shoulder), the plate's bottom on the floor line from the feet, the centre on the wrists,
   and how coloured the face is. With no body model, a bonus for the largest plate (nearest the camera).

What went wrong on the way, kept here because real video will hit the same things:
- The black rim against a dark background is a 13-grey-level edge next to a 160-level face edge, so any
  "fraction of the strongest edge" threshold drops it, and the radius comes out 7 % small (the face ring).
- Fitting the centre and the radius together let edges from the lifter's body pull the centre 3–6 px off.
- The hub's edges are the strongest circle on the plate, and the Hough step kept one circle per centre.

Known limits:
- MediaPipe does not see the drawn lifter in these clips as a person, so the body prior is tested here with
  synthetic joints only. Real lifts will exercise it.
- Without the body model the pick between plates rests on "largest and most complete". It chose the right
  plate in snatch30gym, but a big spare plate closer to the camera would win; **Try another** steps through
  the other candidates.
- The rim edge is found about 0.3–0.6 % outside the true radius on these clips.

## Phase 3 (local engine)

`engine/eval.py` runs the engine pipeline (SAM 2.1 base-plus, half precision on the M5's GPU) on each clip
two ways: given the start mark the web app sends (its own detection, as in normal use), and finding the
plate itself with OWLv2. `tests/score-result.js` scores the results with the web app's analysis code.
Browser = the Phase 2 end-to-end run (automatic detection, browser tracking).

| Clip | | Position RMSE / max | Radius | Pull height | Drop | Peak velocity | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| snatch60 | browser | 0.06 / 0.16 cm | +0.27 % | −0.29 cm | +0.03 cm | −1.1 % | 9 s |
| | engine | 0.08 / 0.20 cm | +0.15 % | −0.19 cm | +0.06 cm | −0.8 % | 123 s |
| | engine, OWLv2 | 0.08 / 0.20 cm | +0.15 % | −0.19 cm | +0.06 cm | −0.8 % | 125 s |
| snatch30hard | browser | 0.22 cm | +0.09 % | +0.10 cm | +0.29 cm | −0.4 % | 3 s |
| | engine | 0.22 / 0.73 cm | +0.58 % | −0.45 cm | +0.15 cm | −0.4 % | 61 s |
| | engine, OWLv2 | 0.22 / 0.72 cm | +0.49 % | −0.35 cm | +0.17 cm | −0.3 % | 61 s |
| cj30 | browser | 0.03 cm | +0.44 % | −0.73 cm | −0.40 cm | −3.9 % | 3 s |
| | engine | 0.03 / 0.16 cm | +0.55 % | −0.82 cm | −0.41 cm | −4.2 % | 88 s |
| | engine, OWLv2 | 0.03 / 0.16 cm | +0.44 % | −0.73 cm | −0.40 cm | −4.1 % | 89 s |
| snatch30occl | browser | 0.22 cm | +0.36 % | −0.26 cm | +0.05 cm | −2.1 % | 3 s |
| | engine | 0.22 / 0.98 cm | +0.28 % | −0.23 cm | +0.09 cm | −1.3 % | 60 s |
| | engine, OWLv2 | 0.22 / 0.99 cm | +0.30 % | −0.25 cm | +0.09 cm | −1.4 % | 62 s |
| snatch30gym | browser | 0.16 cm | +0.44 % | −0.40 cm | 0.00 cm | −1.9 % | 3 s |
| | engine | 0.16 / 0.36 cm | +0.52 % | −0.39 cm | −0.09 cm | −2.1 % | 61 s |
| | engine, OWLv2 | 0.16 / 0.36 cm | +0.49 % | −0.36 cm | −0.08 cm | −2.1 % | 62 s |

The engine found all 5 plates from scratch with OWLv2, including the lifter's plate among three spares, and
measured the oval plate (0.89–0.96 vs 0.90 and 0.97 true). It also ran end to end from the web app on cj30
(85.7 s; the loaded result scored the same as above, saved and reopened like a browser track).

**On these clips the engine ties with the browser pipeline; it doesn't beat it.** The clips are clean
renders of a flat, high-contrast plate on a still camera, where the browser's NCC + edge refinement is already
near the limit, and the engine's final centre comes from the same edge method. What SAM 2 adds is a
segmentation that follows the plate as an object, which matters on things these clips don't have: real
motion blur and lighting, plates that look alike, long or large occlusions, a plate turning edge-on. Real lifts
in `samples/` are needed to show whether it pays for its 20–40× run time.

Speed: about 0.5 s per frame (1–2 minutes for a lift), almost all in SAM 2's memory attention, which MPS runs
without a fused kernel. Half precision saved 40 %. Model load: 3–8 s at engine start.

Problems found and fixed on the way:
- SAM's mask stops inside the dark rim (radius −4.5 %, so every cm reads 4.5 % long). The radius now comes from
  the outermost concentric edge in the image, as in the browser.
- A mask that grows onto the hand overhead put the mask centre 1 cm off for 10 frames; the centre is now
  refined on the plate's edges on every frame that isn't mostly hidden.
- A wrong centre during the occlusion latched the jump check and flagged the next 87 frames.
- **Web app bug:** untracked frames left holes in the points array, `map` skips holes, and the smoother got
  NaN times. Browser tracking never leaves holes, but a saved lift with gaps would have. Fixed in
  `smoothXY` with a test.

## Real clip: IMG_4825.mov (power clean into a front squat)

iPhone HEVC, 1080×1920 portrait (stored rotated), 811 frames over 13.53 s at a variable 57–60 fps (59.97 mean),
black Rogue Hi-Temp bumpers, lifter facing right. The camera is in front of the plate and a little above it,
about 25° off side-on: the sleeve shows, and so does the plate's side wall. No ground truth, so the two
pipelines are compared with each other and with what can be measured on the image.

| | Browser pipeline | Engine (app's mark) | Engine (OWLv2, its own radius) |
| --- | --- | --- | --- |
| Lift-off / peak / received / catch frame | 202 / 260 / 278 / 299 | 202 / 260 / 278 / 298 | 202 / 260 / – / 298 |
| Pull height | 91.6 cm | 91.7 cm | (86.4 cm at 149.8 px) |
| Drop to catch (peak → received) + ride down | 18.0 + 13.2 cm | 17.9 + 13.1 cm | – |
| Toward / away from lifter | 10.8 / 7.6 cm | 10.8 / 7.2 cm | – |
| Peak bar speed | 1.65 m/s (f 243) | 1.74 m/s (f 242) | – |
| Pull / turnover time | 0.69 / 0.58 s | 0.67 / 0.60 s | – |
| Low-confidence frames before the drop | 16 | 10 | 9 |
| Time | 5 s (Node), 33 s (browser) | 495 s, with body tracking | 456 s |

(Both at the corrected radius of 141.3 px; before the fixes below the two pipelines differed by 3 % in every
distance.) The paths agree to 0.83 cm RMS from lift-off. The largest gaps (up to 5 cm) are on
heavily blurred frames as the bar is dropped, where by eye the engine's centre is on the plate face and the
browser's is up to 18 px off.

What the real clip showed that the generated ones couldn't:
- **Scale from a thick plate filmed off-axis.** Both pipelines took the outermost ring, which here is the
  plate's side wall: radius 145.4 px (browser) and 149.8 px (engine) against 138–141 px measured on the face,
  so every distance read 4–8 % short. The rim is now taken only where it shows on both sides of the centre
  (pairs of opposite rays); the browser finds 141.3 px. The engine uses the app's radius when given one.
- **Catch.** In a squat clean the bar is received on the shoulders and then rides down with the lifter, who
  keeps sinking slowly. The old "lowest point" gave a 33.7 cm drop and a 1.6 s turnover. Now: received = the
  strongest braking after the peak (frame 278), catch = where the bar first stops (frame 298), and the
  readout shows the drop to the receive plus the ride down.
- **Frame rate.** ffprobe's average rate for this variable-rate clip is 58.29 fps; the true mean is 59.97. The
  engine now uses the frame times, and the app seeks by the engine's exact frame times when it has them.
- **Joints with gaps** (no joints on some frames) left holes in the joint array, which the smoother turned into
  NaN: every body check read n/a. Fixed, with a test.
- Frame-time drift with the nominal 60 fps is under 5 ms on this clip, so the hidden-page fallback barely mattered.

## Phase 4 (body tracking in the engine)

Compared on IMG_4825, frames 0–500 (to the drop), against facts any lift must obey: the hands stay on the bar
during the pull, the thigh and shin don't change length, and a lifter holding still doesn't move.

| | MediaPipe Pose (browser's model) | RTMPose-x, Halpe-26 (rtmlib) |
| --- | --- | --- |
| Lifter found | 501/501 | 501/501 |
| Wrist-to-bar, lift-off to receive: median / spread / worst | 12.8 / 6.0 / 30.7 cm | 10.8 / **3.1** / **17.6** cm |
| Thigh / shin length variation | 11.3 / 5.8 % | **3.5** / **4.8** % |
| Upper arm / forearm length variation | 31.5 / 39.9 % | **12.0** / **22.9** % |
| Jitter while set up and still | **0.26 cm** | 0.89 cm |
| Time per frame | 7 ms | 35 ms |

By eye (pull, receive, squat bottom, standing), MediaPipe puts the hip on the plate during the pull and the
hip and knee inside the thigh in the squat; RTMPose has them in place. Its extra jitter (it sees each frame
fresh) is what the joint smoother removes. **RTMPose is the engine's default.** The wrist sits 11–17 cm from
the plate centre because with the camera off-axis the hands, ~40 cm further from the lens, project aside.

Speed: RTMPose-x runs on CoreML (Apple GPU / Neural Engine) at 17 ms; its YOLOX-x person detector won't convert
to CoreML (0.5 s on the CPU), so it runs on the first frame, after the lifter is lost and once a second, and
the box comes from the last frame's joints in between. 417 → 35 ms per frame. Body tracking adds ~50 s to a
13 s clip.

Per-frame confidence (in the result's `frames[i]`): joint visibility, wrist-to-bar distance, and the plate's
width ÷ height on that frame as the side-on check. On IMG_4825: visibility 0.74 at set-up (the plate hides the
feet), 0.82 in the pull, 0.71 in the squat. A joint-based side-on measure was tried and dropped: it read 0.96
("side-on") on this 25°-off camera, because pose models put a hidden far shoulder and hip almost on top of the
near ones. On the generated figure (not a person) RTMPose reports joints with visibility 0.3 and the wrist
45–79 cm from the bar: the confidence flags it as junk.

Checks with the engine's joints run end to end (all ten give a verdict), but on this clip some verdicts are
wrong for reasons Phase 5 has to handle:
- "Feet jumped 21 cm back" and "heel lifted 3 cm at lift-off": during set-up the plate hides the feet and the
  model guesses them (visibility 0.35–0.5) behind it, so the start position is wrong.
- "Arms bend early, 17 ms before extension": that is the pull-under starting.
- Bar-vs-body distances in cm mix the plate's plane with the lifter's, ~0.3–0.4 m further away, on a camera
  25° off side-on.

### 3D methods

| | GVHMR | WHAM | HMR 2.0 |
| --- | --- | --- | --- |
| Code licence | ZJU: education, research, non-profit only | MIT | MIT |
| Body models | SMPL + SMPL-X (registration at MPI) | SMPL (registration) | SMPL (registration) |
| Static camera without CUDA-only code | yes, `-s` skips visual odometry | `--estimate_local_only` skips SLAM | single frame |
| Temporal | video, gravity-aligned | video | per frame |
| Heavy parts | ViTPose-H, YOLOv8x, HMR2 features (ViT-H) | ViTPose, DPVO/DROID (optional) | ViT-H |

SMPL's licence allows non-commercial research by a single user. GVHMR fits best (static camera, gravity-aligned
joint angles that survive an off-axis camera), but nothing can be run until the SMPL / SMPL-X files are
downloaded under your own registration, and MPS support is untested by its authors.

## Real clips


None yet. Add your own lifts to `samples/` to score the pipeline on real video.

## Phase 5 (technique checks)

What changed (js/checks.js, thresholds in js/config.js `checks`):
- A joint counts only where the model's visibility is ≥ 0.6. A joint inside the plate's disc counts at half
  its visibility in the confidence: the near plate is in front of the lifter, and models still report the
  hips at full extension, the feet at the start and the hands in the pull as seen.
- Every finding has a confidence (joint visibility × camera factor × share of measured bar frames). Below 0.35
  it reads n/a with the reason and what was measured.
- Distances between body points (feet, heels, shoulders vs bar, bar vs mid-foot) are judged in femur lengths
  of this lifter. Bar-only limits stay in cm: the lifter stands ~1 m behind the near plate, so the plate's
  scale makes the body look 20–35 % small (on IMG_4825 the femur measures 28.5 cm at plate scale) and can't
  size a lifter.
- Camera angle (plate width ÷ height): bar distances across the frame are divided by it; bar-vs-body checks
  are skipped below 0.92 and lose confidence with the square of the camera factor above it, so a reading near
  the limit can't flip a confident verdict.
- The start line is where the bar leaves the floor (it rolled 3.7 cm during the set-up on IMG_4825).
- A wrist inside the plate's disc is replaced by the bar centre for elbow angles (the model's wrist sat
  60–100 px off with visibility 0.8+, reading 149° where the arm was straight).
- An elbow bend in the last 60 ms before full extension is the pull-under, not an early arm pull.
- The feet's and heels' resting place comes from frames where they're seen; when the plate hides them at the
  start, from the first pull.
- The plate finder now refits the rim's two axes on its own edge points (generated clips: radius within
  0.41 %, ratio exact).

Tests: 58, every check with a fault or watch case and a good case, plus hidden feet, joints barely seen,
a turned camera, a camera near the limit, lifter size, a wrist behind the plate, a joint behind the plate,
the pull-under bend, a bar rolling during set-up and a jerk dip that drifts. The generated clips track and
detect as before.

IMG_4825, both pipelines on the final rules:

| Check | Browser only (MediaPipe) | Engine joints (RTMPose) |
| --- | --- | --- |
| Shoulders over the bar | good, 61 % | n/a: camera |
| Hips and shoulders rise together | good, 88 % | good, 54 % |
| Bar close off the floor | good, 88 % | good, 63 % |
| Heels stay down | n/a, 30 % | n/a, 31 % |
| Arms stay long | watch, 69 % | watch, 51 % |
| Full extension | good, 71 % | watch, 56 % |
| Bar close at the hips | good, 88 % (2.5 cm) | watch, 63 % (3.6 cm) |
| Feet land in place | watch, 44 % (16.6 cm back) | watch, 53 % (18.6 cm back) |
| Bar over mid-foot | fault, 61 % | n/a: camera |

Since this phase the readout's "toward / away from lifter" is measured from where the bar leaves the floor, so
on IMG_4825 it reads 15.2 / 3.3 cm instead of the 10.8 / 7.6 cm in the Phase 3–4 tables (the bar rolled
3.7 cm forward during the set-up).

Checked on the frames: the feet do land about 17 cm back; the arms are close to straight through the pull;
at full extension the plate covers the hip and the two models place it 20 px apart (hence 163° vs 174°).

Known limits:
- The camera angle estimate differs between the pipelines on this clip (browser 0.951–0.967 depending on how
  the frame is resampled, engine 0.91, the face itself ≈ 0.94). The gradual rule keeps it from flipping
  verdicts, but the browser's two bar-vs-body verdicts here rest on a 0.97 that is probably high.
- 2D joint angles from an off-axis camera are approximate; a 3D model (GVHMR) would be the real fix.
- Bar-vs-body comparisons mix two depths on every side view, not only off-axis ones; their confidence is
  capped by the camera factor but the bias isn't modelled.
- Confidence weights are set by reasoning, not fitted: Phase 7's labels can calibrate them.

## Phase 6 (local AI coach)

Ollama 0.40.7 with `qwen3:14b` (Q4, 9.3 GB) on the M5, on IMG_4825 (clean, engine joints, camera 0.91):

| Run | Time | Main issue | Grounding check |
| --- | --- | --- | --- |
| Rules in the prompt only | 76 s | Full extension (confidence 56 %, below the 60 % limit) | passed, but broke the confidence rule |
| + low-confidence findings flagged `"uncertain": true` | 88 s | Full extension again | passed, rule still broken |
| + main issue limited by the JSON schema to findings it may use | 74 s | Bar swings out at the hips (63 %) | passed |
| Same, in the app (Coach tab) | 64 s | Bar swings out at the hips | passed |

A prompt rule was not enough: the model kept building on the uncertain finding even when it was flagged. The
answer now has a `main_issue_id` whose allowed values are the faults and watches that aren't uncertain, and
Ollama applies the schema as a grammar, so the model can't pick another; `checkAnswer` flags it if a server
ignores the schema. Every number and frame cited in all four runs was in the measurements. Clicking a cited
frame moves the video there; a follow-up question ("Why did my feet land so far back?") was answered in
plain text with frames f 299 and f 243 and only measured numbers.

Known limits:
- The causal chain is the model's reasoning from the draft notes, not measured. On this lift it says the bar
  swinging out caused the feet to land back, which the notes support but the video can't prove.
- Numbers in the drill text come from the notes (percentages of a best lift) and aren't checked.
- Qwen3 thinks before answering; that is most of the minute. A smaller or non-thinking model would be faster
  but wasn't tried.
- The notes need a coach's review before the advice can be trusted.

## Phase 7 (labels and dataset)

- **Labels** on every saved lift (Library → open a lift → Your labels): make / miss, an overall 1–5 rating,
  your verdict next to each of the app's findings (good / watch / fault / unsure), and notes. Stored on the
  record (so backups carry them), kept when the lift is re-saved, cleaned to known values, versioned.
- **Dataset export** (Library → Dataset): every labelled lift with frame-by-frame bar position, velocity and
  acceleration, hip / knee / elbow / back angles (null where the joint wasn't seen), phases, the findings now
  and when saved, and the labels; stamped with the analysis settings used. Format: `docs/dataset-format.md`.
  Everything is re-computed from the saved raw measurements, so exports are reproducible.
- Saved lifts now record whether the browser or the engine tracked them, and each finding's confidence.

Checked in the app on IMG_4825 (engine result): saved, labelled (make, 4/5, three verdicts, notes), card
shows "labelled · make", dataset built with 512 frames × 13 columns (37 KB), peak 91.6 cm at speed 0.01 m/s,
hip 162.6° / knee 163.3° at full extension, 23 % of frames without a hip angle (hidden), labels intact after
re-saving. Tests: 70 (4 new for the dataset).

Not done, as planned: no model is trained.

## Good-lift reference

`knowledge/good-lift.md`: positions of the snatch, clean and jerk, and published elite measurements with their
sources (Cunanan 2020, Nagao 2019, Gourgoulis 2000, Harbili & Alptekin 2014, Liu 2024, Prassas & Fulton),
each figure checked against the paper's own text or tables. No open elite ranges were found for the clean's
bar path; the file says so and the app shows no clean comparison. `js/reference.js` holds the ranges and
measures each lift the same way (horizontal distances corrected for the camera angle).

Measured against the generated clips' truth (Node, exact frame times): snatch60 sweep back 2.99 cm (true 3.0),
loop 5.47 (5.5), catch behind the start 3.99 (4.0), pull height 99.96 (100), drop 20.08 (20), catch height
79.9 % (80 %), peak speed 1.89 m/s (1.905); snatch30hard (oval camera) sweep back 2.97, loop 5.70, catch 4.41;
cj30 drive speed 2.79 m/s (2.75).

Found on the way: a page that opens a video while hidden timed throttled playback as 4 fps (16 frames for a
235-frame clip). The playback fallback now accepts only a common camera rate; otherwise it reports the rate as
unknown and uses 30 fps with a note.

## Final check (October 2026, IMG_4825 and every feature)

| Check | Result |
| --- | --- |
| Real clip, browser | 60 fps detected, plate r 141 px found in 1.1 s, 589 frames tracked, exact frame times |
| Real clip, engine (from the app) | plate `found: "hint"`, r 141.5 px (same as the browser); 777 frames, body on 643; lift frames agree with the earlier engine run to 1.36 px (≈ 0.2 cm) |
| Demo, playback, ←/→, Space, scrub | pass (¼× played 11 frames in 1.5 s, as expected) |
| Mark by hand (click + drag), Clear, Track | pass: 84/84 frames, 0.02 px mean from the automatic path |
| Frame-rate override | pass after a fix (below) |
| PNG / video export | 720×960 PNG; 2.77 s 720×960 MP4 |
| Technique, coach, library, labels, dataset, backup round trip | pass |
| Phone layout (375 px) | no horizontal scroll on any tab |
| Offline | all 32 app files cached; loads and tracks the demo with the server stopped |

Fixed during the check:
- The engine was sent no plate hint unless the current frame was the marked frame, so it used OWLv2's
  147.9 px radius (4 % scale error). It now uses the mark, else where the tracked path starts.
- Saved paths (Compare, Ghost) measured horizontal distance from frame 0, the readout from lift-off (3.7 cm
  set-up roll on this clip). Both now start at lift-off.
- Changing the frame rate cleared the mark but left the old "Found the plate" box, whose **Use this** did
  nothing. The plate is now found again.

Known: this engine run took 1830 s vs 446 s before (cause not found; memory was not under pressure afterwards).
The coach once said lighter lifts are slower in a follow-up answer; good-lift.md says the opposite.

## The lift only (October 2026)

The path, saved paths (Compare, Ghost), video export and dataset now cover the lift from the last frame with the
bar on the floor (within 0.5 cm) to where the bar starts falling after the recovery (once it falls 15 cm below its
highest point after the catch, walking back to where it fell faster than 0.1 m/s). A clean & jerk whose jerk isn't
found keeps everything. Tracking itself is unchanged.

| Clip | Tracked | Lift |
| --- | --- | --- |
| IMG_4825, browser in the app | f0–588 | f191–441 (the hold at ~105.5 cm ends ~f442; drop after) |
| IMG_4825, engine | f0–511 | f197–442 |
| snatch60 / snatch30gym / cj30 (no drop in the clip) | to the end | from lift-off to the end |

Video export of IMG_4825: frames 191–441, 4.45 s at 1×.
