/* Scores the current S (tracked points, times) against a clip's truth file. Used in the browser by
   eval-sample.js and under Node by eval-node.js. Errors are app − truth. */
import { S } from '../js/state.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from '../js/path.js';

export function score(truth) {
  const T = truth.perFrame, cmTrue = 100 / truth.pxPerM, M = truth.metrics, K = truth.keyFrames, fps = truth.fps;
  const out = { tracked: S.points.filter(Boolean).length, frames: truth.frames, lowConfidence: S.points.filter(p => p && p.low).length };
  const r2 = x => x == null ? null : +x.toFixed(2), r3 = x => x == null ? null : +x.toFixed(3);
  const tPull = M.peakVelocity.t - K.liftoff / fps, tTurn = K.catch / fps - M.peakVelocity.t;
  const keep = S.smooth;
  for (const smooth of [false, true]) {
    S.smooth = smooth;
    const pts = pathPoints(), a = analyse(pts), ph = barPhases(pts), c = cmPerPx();
    let se = 0, mx = 0, n = 0, sv = 0, nv = 0;
    pts.forEach((p, i) => {
      if (!p || !T[i]) return;
      const e = Math.hypot(p.x - T[i].x, p.y - T[i].y) * cmTrue; se += e * e; mx = Math.max(mx, e); n++;
      if (i >= K.liftoff && i <= K.catch) { sv += (-p.vy * c / 100 - T[i].vy) ** 2; nv++; }
    });
    let tErr = 0, tn = 0;   // frame time error vs truth (ms)
    pts.forEach((p, i) => { if (p && T[i]) { tErr = Math.max(tErr, Math.abs(timeOf(i) - T[i].t) * 1000); tn++; } });
    out[smooth ? 'smoothed' : 'raw'] = {
      rmsePosCm: r2(Math.sqrt(se / n)), maxPosCm: r2(mx), rmseVelPull: r3(Math.sqrt(sv / nv)),
      pullHeightErrCm: r2(a.height * c - M.pullHeightCm), dropErrCm: r2(a.dropTotal * c - M.dropCm),   // the clips have no separate receive
      peakVelErrPct: a.vMax == null ? null : r2((a.vMax / M.peakVelocity.ms - 1) * 100),
      peakVelFrameErr: a.vIdx == null ? null : r2(a.vIdx - M.peakVelocity.frame),
      pullTimeErrMs: a.pullTime == null ? null : Math.round((a.pullTime - tPull) * 1000),
      turnoverTimeErrMs: a.catchTime == null ? null : Math.round((a.catchTime - tTurn) * 1000),   // peak velocity → catch
      liftoffFrameErr: ph.liftoff == null ? null : ph.liftoff - K.liftoff, peakFrameErr: a.peak - K.peak, catchFrameErr: a.catchIdx - K.catch,
      maxTimeErrMs: r2(tErr),
      ...(K.dipBottom != null ? { jerkFound: !!a.jerk, dipBottomFrameErr: a.jerk ? a.jerk.dipBottom - K.dipBottom : null } : {}),
    };
  }
  S.smooth = keep;
  return out;
}
