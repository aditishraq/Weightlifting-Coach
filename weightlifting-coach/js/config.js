/* Every tunable number in one place. Distances are cm on the lifter's side plane (from the 450 mm plate),
   angles are degrees (180° = straight joint), times are seconds. [good, watch] pairs: up to the first value
   is good, up to the second is watch, beyond it is a fault. These are starting points, not a coaching standard. */

export const CONFIG = {
  phases: {
    liftoffCm: 1.5,          // bar must rise this far above its start to count as off the floor
    peakDropCm: 1.5,         // pull peak ends once the bar falls this far below its highest point
    catchRiseCm: 3,          // catch search ends once the bar rises this far above its lowest point
    catchReachCm: 0.5,       // without velocities: catch = first frame within this of the lowest point
    catchStopMs: 0.1,        // catch = first frame after the drop where the bar falls slower than this (m/s) ...
    fallMs: 0.3,             // ... once it has fallen faster than this
    receiveAccelMs2: 5,      // received = the strongest braking after the peak, if at least this (m/s², upward)
    jerkAbovePeakCm: 15,     // a later high point this far above the pull peak counts as a jerk
    dipStepCm: 0.3,          // dip bottom: walk back while each earlier frame is no more than this higher
    dipStartCm: 0.5,         // dip start: last frame within this of the standing height before the dip
    kneeNoPoseCm: 25,        // bar height used as "at the knee" when there is no body model
    beginCm: 0.5,            // the lift begins at the last frame the bar is within this of the floor before lift-off
    finishDropCm: 15,        // after the recovery, a fall this far below the highest point is the drop; the lift
                             // ends where that fall started (falling slower than catchStopMs)
  },

  smoothing: {
    // Only the ratio jerkQ / measCm² matters for the result. Tuned on the generated clips (docs/baseline.md).
    jerkQ: 8000,             // process noise: white-jerk spectral density, m²/s⁵ (higher follows sharp turns better)
    measCm: 0.1,             // bar measurement noise (1σ) for a confident match
    poseMeasCm: 1.5,         // joint measurement noise (1σ) at visibility 1; scaled by 1/visibility
    poseJerkQ: 1.8e6,        // joints, m²/s⁵: same bandwidth as the bar (8000 × (1.5 / 0.1)²); not tuned on real pose yet
  },

  tracking: {
    workScalePx: 28,         // the plate radius is resampled to this many px for matching
    tplRadii: 1.5,           // template side, in plate radii
    goodScore: 0.6,          // below this, also try the first-frame template
    lowScore: 0.35,          // below this a frame is low confidence (prediction only)
    lostFrames: 5,           // this many low frames in a row means the bar is lost
    updateScore: 0.8,        // template adapts only on matches at least this good
    updateRate: 0.15,        // blend weight of the new patch when adapting
    refindSeconds: 0.5,      // keep trying to re-find the plate for this long after losing it
    refindScore: 0.5,        // a re-found circle must match the first template at least this well
    maxAccelMs2: 50,         // the bar can't stray further than ½·a·t² from its constant-velocity prediction ...
    gateSlackCm: 1.5,        // ... plus this; matches outside that gate are rejected
  },

  checks: {
    // Inputs. A joint counts on a frame only if the body model's visibility is at least minVis. Each finding
    // gets a confidence 0..1 (joint visibility × camera angle × bar track quality); below minConfidence the
    // check reports n/a with the reason instead of a verdict it can't back up.
    minVis: 0.6,
    minConfidence: 0.35,
    // Body size: distances between body points are judged in femur lengths (hip to knee, measured on this
    // lifter), which suits any lifter's build. The ≈ cm values below are for a 43 cm femur (1.75 m lifter).
    // Bar-only limits stay in cm: the plate's scale doesn't apply to the lifter, who stands behind it.
    // Camera angle, from the plate's width ÷ height (1 = side-on). Bar distances across the frame are divided
    // by it. Bar-vs-body comparisons (the plate and the lifter sit at different depths, so their gap in the
    // picture isn't their gap on the platform) are skipped below mixedPlaneMinRatio and lose confidence
    // steeply above it (camera factor squared), so a reading near the limit can't flip a confident verdict.
    sideOnZero: 0.85,        // ratio at which the camera factor of the confidence reaches 0
    mixedPlaneMinRatio: 0.92,   // the same point at which the app warns that the plate looks oval

    shouldersFemur: [-0.05, -0.12],   // shoulders ahead (+) of the bar at lift-off and at the knee (≈ −2 / −5 cm)
    hipsLeanDeg: [4, 8],     // torso lean added between lift-off and knee
    close1Cm: [2, 4],        // forward drift from the start line before the knee
    close1BackCm: 0.5,       // back-toward-the-shins movement worth mentioning
    heelRiseFemur: 0.06,     // heel rise before mid-thigh that triggers a watch (≈ 2.5 cm)
    armsDeg: [160, 150],     // smallest elbow angle before full extension (bigger is better) ...
    armsLeadMs: 60,          // ... counting only bends at least this long before extension (later is the pull-under)
    extHipDeg: [170, 160],   // hip angle at full extension (bigger is better)
    extKneeDeg: 160,         // knee angle needed (with the hip) for good
    extLeanBackDeg: 2,       // lean back past vertical worth mentioning
    close2Cm: [3, 6],        // forward of the start line from the knee to the peak
    feetFwdFemur: 0.07,      // feet landing further forward than this is a fault (≈ 3 cm)
    feetBackFemur: 0.19,     // feet landing further back than this is a watch (≈ 8 cm)
    catchMidfootFemur: [0.09, 0.19],   // bar vs mid-foot at the catch, either direction (≈ 4 / 8 cm)
    dipBarCm: [2.5, 5],      // bar travel forward during the jerk dip
    dipLeanDeg: [5, 9],      // torso tip forward during the dip
    driveFwdCm: [3, 6],      // bar forward from dip bottom to lockout
    driveBackCm: 8,          // bar back from dip bottom beyond this is a watch
    lockArriveCm: 3,         // "arrived overhead" = within this of the top
    lockWindowS: 0.6,        // look for elbow straightening this long after arrival
    pressOutDeg: 155,        // elbow below this on arrival ...
    pressOutGainDeg: 10,     // ... that then straightens by more than this is a press-out
    lockDeg: 165,            // elbow must reach this overhead
  },

  detect: {
    plateHeightFrac: 0.13,   // plate radius ≈ this × the lifter's standing height (450 mm plate, 1.6–1.9 m lifter)
    legTorsoFrac: 0.779,     // ankle→knee + knee→hip + hip→shoulder ≈ this × standing height (Drillis & Contini)
    radiusRange: 0.3,        // with a body model, search radii within ±this of the expected radius
    radiusTol: 0.2,          // σ of the radius score, as a fraction of the expected radius (body proportions vary ~10 %)
    minRadiusFrac: 0.04,     // without a body model, radii from this ...
    maxRadiusFrac: 0.25,     // ... to this × the shorter frame side
    workPx: 320,             // the frame is shrunk to this many px on its longer side for the circle search
    candidates: 12,          // Hough circles to refine
    weights: { rim: 3, radius: 1, floor: 2, wrist: 2, colour: 0.5, size: 1.5 },   // size: only without a body model
    minScore: 0.45,          // below this the result is shown as a weak guess
    ellipseWarn: 0.92,       // axis ratio below this means the camera is not side-on
  },

  engine: {
    url: 'http://127.0.0.1:8765',   // the local engine (engine/start.sh); nothing else is ever contacted
    healthMs: 800,                  // how long to wait for /health before using the browser pipeline
    pollMs: 500,                    // job progress polling interval
  },

  coach: {
    url: 'http://localhost:1234/v1',   // LM Studio's default; Ollama: http://localhost:11434/v1 (changeable in the Coach tab)
    model: '',               // empty = the first model the endpoint lists
    historyLifts: 5,         // earlier saved lifts of the same type given to the coach
    lowConfidence: 0.6,      // findings below this confidence are called uncertain
    connectMs: 1500,
    answerMs: 300000,        // a 14B model on a laptop can take a minute or two
  },

  power: { g: 9.81 },
};
