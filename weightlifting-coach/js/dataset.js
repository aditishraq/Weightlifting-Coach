/* Labelled-lift dataset (docs/dataset-format.md): for each saved lift that has labels, the bar path, its
   velocity and the joint angles frame by frame, the lift's phases and findings, and the labels. Every series is
   re-computed from the saved raw measurements with the current analysis code, and the export records the
   settings it used, so a dataset can be rebuilt and compared later. No DOM. */
import { S } from './state.js';
import { CONFIG } from './config.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from './path.js';
import { TRIPLE, finishPose, jointAng, jp, lean } from './pose.js';
import { evaluate } from './checks.js';

export const DATASET_VERSION = 1;
export const LABELS_VERSION = 1;
export const VERDICTS = ['good', 'watch', 'fault', 'unsure'];

/* A lift counts as labelled once any label is set. */
export const isLabelled = r => !!(r.labels && (r.labels.outcome || r.labels.rating || r.labels.notes ||
  Object.values(r.labels.verdicts || {}).some(Boolean)));

/* Clean labels: known values only, so a dataset never carries stray UI state. */
export function cleanLabels(l = {}) {
  const verdicts = {};
  for (const [id, v] of Object.entries(l.verdicts || {})) if (VERDICTS.includes(v)) verdicts[id] = v;
  const rating = Number.isInteger(l.rating) && l.rating >= 1 && l.rating <= 5 ? l.rating : null;
  return {
    version: LABELS_VERSION, outcome: l.outcome === 'make' || l.outcome === 'miss' ? l.outcome : null, rating, verdicts,
    notes: typeof l.notes === 'string' ? l.notes.trim() : '', labelledAt: l.labelledAt || null,
  };
}

const KEYS = ['src', 'radius', 'facing', 'lift', 'axisRatio', 'points', 'times', 'pose', 'poseS', 'poseSide', 'smooth', 'kg', 'tech'];

/* Runs fn with a saved record loaded into the analysis state, then puts the state back. */
function withRecord(rec, fn) {
  const keep = Object.fromEntries(KEYS.map(k => [k, S[k]]));
  try {
    Object.assign(S, { src: { fps: rec.video && rec.video.fps || 30 }, radius: rec.radius, facing: rec.facing, lift: rec.lift,
      axisRatio: rec.axisRatio ?? null, points: [], times: [], pose: [], poseS: [], smooth: true, kg: rec.weightKg ?? null });
    rec.points.forEach((p, j) => { if (p) S.points[rec.first + j] = { x: p[0], y: p[1], score: 1, ...(p[2] ? { low: true } : {}) }; });
    (rec.times || []).forEach((t, j) => { if (t != null) S.times[rec.first + j] = t; });
    if (rec.pose) {
      rec.pose.frames.forEach((f, j) => {
        if (!f) return;
        const L = []; for (let k = 0; k < 33; k++) L.push({ x: f[k * 4], y: f[k * 4 + 1], z: f[k * 4 + 2], v: f[k * 4 + 3] });
        S.pose[rec.pose.first + j] = L;
      });
      if (S.pose.some(Boolean)) finishPose();
    }
    S.tech = evaluate();
    return fn();
  } finally { Object.assign(S, keep); }
}

const r = (v, d) => v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

/* One lift's dataset entry. */
export function liftEntry(rec) {
  return withRecord(rec, () => {
    const pts = pathPoints(), a = analyse(pts), ph = barPhases(pts), c = cmPerPx(), m = c / 100, F = S.facing, tech = S.tech;
    if (!a || !ph) return null;
    const x0 = pts[a.start].x, y0 = pts[a.first].y, t0 = timeOf(ph.liftoff ?? a.first);
    const seen = (i, names) => names.every(n => { const p = jp(i, n); return p && p.v >= CONFIG.checks.minVis; });
    const angle = (i, j) => S.poseS[i] && seen(i, TRIPLE[j]) ? jointAng(i, j) : null;
    const cols = { frame: [], t: [], barXcm: [], barYcm: [], vxMs: [], vyMs: [], axMs2: [], ayMs2: [], low: [],
                   hipDeg: [], kneeDeg: [], elbowDeg: [], backFromVerticalDeg: [] };
    for (let i = a.begin; i <= a.end; i++) {   // the lift only, not the set-up or the drop
      const p = pts[i], raw = S.points[i];
      cols.frame.push(i); cols.t.push(r(timeOf(i) - t0, 4));
      // +x is away from the lifter, from where the bar left the floor; +y is up, from the bar on the floor
      cols.barXcm.push(p ? r((p.x - x0) * F * c, 2) : null); cols.barYcm.push(p ? r((y0 - p.y) * c, 2) : null);
      cols.vxMs.push(p ? r(p.vx * F * m, 3) : null); cols.vyMs.push(p ? r(-p.vy * m, 3) : null);
      cols.axMs2.push(p ? r(p.ax * F * m, 2) : null); cols.ayMs2.push(p ? r(-p.ay * m, 2) : null);
      cols.low.push(raw ? (raw.low ? 1 : 0) : null);
      cols.hipDeg.push(r(angle(i, 'hip'), 1)); cols.kneeDeg.push(r(angle(i, 'knee'), 1)); cols.elbowDeg.push(r(angle(i, 'elbow'), 1));
      cols.backFromVerticalDeg.push(S.poseS[i] && seen(i, ['shoulder', 'hip']) ? r(lean(i), 1) : null);
    }
    const k = tech && tech.keys || {};
    return {
      id: rec.id, date: rec.date, lift: rec.lift, weightKg: rec.weightKg ?? null,
      video: rec.video ? { name: rec.video.name, W: rec.video.W, H: rec.video.H, fps: rec.video.fps } : null,
      source: rec.source || 'browser', bodyModel: !!rec.pose,
      scale: { plateRadiusPx: rec.radius, cmPerPx: r(c, 5), plateWidthOverHeight: rec.axisRatio ?? null, femurPx: tech && tech.femurPx ? r(tech.femurPx, 1) : null },
      phases: { liftoff: ph.liftoff, barAtKnee: k.knee ?? null, fullExtension: k.ext ?? null, peakSpeed: a.vIdx, peak: a.peak,
                received: a.receive, catch: a.catchIdx, ...(a.jerk ? { jerkDipStart: a.jerk.dipStart, jerkDipBottom: a.jerk.dipBottom, jerkLockout: a.jerk.top } : {}) },
      summary: { pullHeightCm: r(a.height * c, 2), dropToCatchCm: r(a.drop * c, 2), rideDownCm: r(a.rideDown * c, 2),
                 towardLifterCm: r(a.toward * c, 2), awayFromLifterCm: r(a.away * c, 2), peakSpeedMs: r(a.vMax, 3),
                 pullTimeS: r(a.pullTime, 3), turnoverTimeS: r(a.turnoverTime, 3) },
      findings: (tech && tech.checks || []).map(f => ({ id: f.id, status: f.status, confidence: f.confidence, frame: f.frame })),
      findingsWhenSaved: (rec.findings || []).map(f => ({ id: f.id, status: f.status, confidence: f.confidence ?? null })),
      labels: cleanLabels(rec.labels),
      series: cols,
    };
  });
}

/* The whole dataset from library records; only labelled lifts go in. */
export function buildDataset(records, now = new Date()) {
  const lifts = records.filter(isLabelled).map(liftEntry).filter(Boolean);
  return {
    format: 'wlcoach-dataset', version: DATASET_VERSION, labelsVersion: LABELS_VERSION, exportedAt: now.toISOString(),
    // the settings the series and findings were computed with, so a later dataset can be compared fairly
    analysis: { phases: CONFIG.phases, smoothing: CONFIG.smoothing, checks: CONFIG.checks },
    counts: { lifts: lifts.length, labelledVerdicts: lifts.reduce((n, l) => n + Object.keys(l.labels.verdicts).length, 0),
              makes: lifts.filter(l => l.labels.outcome === 'make').length, misses: lifts.filter(l => l.labels.outcome === 'miss').length },
    lifts,
  };
}
