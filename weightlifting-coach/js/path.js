import { S } from './state.js';
import { CONFIG } from './config.js';
import { smoothXY } from './smooth.js';

/* ---------- Path geometry, lift phases & readout ---------- */

export const cmPerPx = () => 22.5 / S.radius;   // a 450 mm plate has a 22.5 cm radius
/* Presentation time of frame i in seconds: measured when the frame was tracked, else from the frame rate. */
export const timeOf = i => S.times[i] ?? i / S.src.fps;

/* Bar path with velocity (px/s) and acceleration (px/s²) from the Kalman + RTS smoother. With smoothing off the
   positions are the raw tracked ones; velocity and acceleration always come from the smoother. */
export function pathPoints() {
  const P = S.points, pxPerCm = 1 / cmPerPx(), Z = CONFIG.smoothing;
  const r = (Z.measCm * pxPerCm) ** 2, q = Z.jerkQ * (100 * pxPerCm) ** 2;
  const f = smoothXY(P, timeOf, i => P[i].low ? Infinity : r, q);
  return P.map((p, i) => !p ? null : S.smooth ? f[i] : { ...f[i], x: p.x, y: p.y });
}

/* Splits the bar path into lift-off, pull peak, catch and (for a clean & jerk) the jerk dip and lockout. */
export function barPhases(pts) {
  const T = CONFIG.phases;
  const idx = []; pts.forEach((p, i) => p && idx.push(i));
  if (idx.length < 2) return null;
  const first = idx[0], last = idx[idx.length - 1], y0 = pts[first].y, c = cmPerPx();
  const h = i => (y0 - pts[i].y) * c;
  // begin/end: the lift itself, without the set-up before it and the drop after it
  const ph = { first, last, h, begin: first, end: last, liftoff: null, peak: null, receive: null, catchIdx: null, catchLow: null, jerk: null };
  const lo = idx.find(i => h(i) > T.liftoffCm);
  if (lo === undefined) return ph;
  ph.liftoff = lo;
  let b = lo; while (b > first && pts[b - 1] && h(b - 1) > T.beginCm) b--;
  ph.begin = pts[b - 1] && b > first ? b - 1 : b;
  let peak = lo;
  for (const i of idx) {
    if (i < lo) continue;
    if (h(i) > h(peak)) peak = i; else if (h(i) < h(peak) - T.peakDropCm) break;
  }
  let low = peak;
  for (const i of idx) {
    if (i <= peak) continue;
    if (h(i) < h(low)) low = i; else if (h(i) > h(low) + T.catchRiseCm) break;
  }
  // Catch: where the falling bar first stops, not the lowest point: after a squat catch the lifter often sinks
  // slowly for a while. Received: the strongest braking between the peak and the catch, where the bar meets the
  // shoulders or locked arms (in a squat catch it then rides down with the lifter).
  const m = c / 100, up = i => pts[i].vy == null ? null : -pts[i].vy * m, acc = i => -pts[i].ay * m;
  let cat = null, fell = false;
  if (up(peak) != null) for (const i of idx) {
    if (i <= peak || i > low) continue;
    if (up(i) < -T.fallMs) fell = true;
    else if (fell && up(i) > -T.catchStopMs) { cat = i; break; }
  }
  cat ??= idx.find(i => i > peak && i <= low && h(i) <= h(low) + T.catchReachCm) ?? low;
  let rec = cat, best = T.receiveAccelMs2;
  if (up(peak) != null) for (const i of idx) if (i > peak && i <= cat && up(i) < 0 && acc(i) >= best) { best = acc(i); rec = i; }
  ph.peak = peak; ph.catchIdx = cat; ph.catchLow = low; ph.receive = rec;
  if (S.lift === 'cj') {
    let top = low;
    for (const i of idx) if (i > low && h(i) > h(top)) top = i;
    if (h(top) > h(peak) + T.jerkAbovePeakCm) {
      let b = top; while (b > low && pts[b - 1] && h(b - 1) <= h(b) + T.dipStepCm) b--;
      // dip starts at the last frame still within dipStartCm of the standing height before it
      let top0 = -Infinity; for (let i = low; i <= b; i++) if (pts[i]) top0 = Math.max(top0, h(i));
      let s = b; for (let i = b; i >= low; i--) if (pts[i] && h(i) >= top0 - T.dipStartCm) { s = i; break; }
      ph.jerk = { dipStart: s, dipBottom: b, top };
    }
  }
  // End: after the catch (or the jerk), follow the bar up through the recovery; once it falls finishDropCm below
  // its highest point the lift is over, and it ends where that fall started. A clean & jerk whose jerk wasn't
  // found keeps everything, since the jerk dip would look like the drop.
  if (S.lift !== 'cj' || ph.jerk) {
    let top = ph.jerk ? ph.jerk.top : low;
    for (const i of idx) {
      if (i <= top) continue;
      if (h(i) > h(top)) top = i;
      else if (h(i) < h(top) - T.finishDropCm) {
        let e = i; while (e > top && pts[e - 1] && (up(e) != null ? up(e) < -T.catchStopMs : h(e - 1) > h(e))) e--;
        ph.end = e; break;
      }
    }
  }
  return ph;
}

export function analyse(pts) {
  const ph = barPhases(pts);
  if (!ph) return null;
  // heights from the bar on the floor; the start line (horizontal 0) where it leaves the floor, since the bar
  // often rolls a few cm during the set-up
  const { first, last, liftoff, begin, end } = ph, start = liftoff ?? first, x0 = pts[start].x, y0 = pts[first].y;
  let peak = ph.peak, cat = ph.catchIdx, rec = ph.receive;
  if (peak == null) { peak = first; for (let i = first; i <= last; i++) if (pts[i] && pts[i].y < pts[peak].y) peak = i; cat = rec = peak; }
  let minD = 0, maxD = 0;
  for (let i = start; i <= cat; i++) {
    if (!pts[i]) continue;
    const d = (pts[i].x - x0) * S.facing;
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
  // Vertical velocity (m/s, up = +) and power during the pull: lift-off to the pull peak.
  const m = cmPerPx() / 100, up = i => -pts[i].vy * m, acc = i => -pts[i].ay * m;
  let vIdx = null, vMax = 0, peakPower = null, work = 0;
  if (liftoff != null && pts[liftoff].vy != null) {
    for (let i = liftoff; i <= peak; i++) if (pts[i] && up(i) > vMax) { vMax = up(i); vIdx = i; }
    if (S.kg > 0 && vIdx != null) {
      // P = m (g + a) v; mean power over the pull is the work done divided by the pull time
      let prev = null;
      for (let i = liftoff; i <= vIdx; i++) {
        if (!pts[i]) continue;
        const p = S.kg * (CONFIG.power.g + acc(i)) * up(i);
        peakPower = Math.max(peakPower ?? 0, p);
        if (prev != null) work += (p + prev.p) / 2 * (timeOf(i) - timeOf(prev.i));
        prev = { i, p };
      }
    }
  }
  const pullTime = vIdx != null ? timeOf(vIdx) - timeOf(liftoff) : null;
  return {
    first, last, begin, end, start, peak, catchIdx: cat, jerk: ph.jerk,
    toward: -minD, away: maxD, range: maxD - minD,
    height: y0 - pts[peak].y, receive: rec,
    drop: pts[rec].y - pts[peak].y, rideDown: pts[cat].y - pts[rec].y, dropTotal: pts[cat].y - pts[peak].y,
    catchD: (pts[cat].x - x0) * S.facing,
    jerkD: ph.jerk ? (pts[ph.jerk.top].x - pts[ph.jerk.dipBottom].x) * S.facing : null,
    vMax: vIdx != null ? vMax : null, vIdx, vHeight: vIdx != null ? y0 - pts[vIdx].y : null,
    pullTime, turnoverTime: vIdx != null ? timeOf(rec) - timeOf(vIdx) : null, catchTime: vIdx != null ? timeOf(cat) - timeOf(vIdx) : null,
    peakPower, meanPower: pullTime > 0 && peakPower != null ? work / pullTime : null,
    lowCount: S.points.filter(p => p && p.low).length, count: S.points.filter(Boolean).length,
  };
}
