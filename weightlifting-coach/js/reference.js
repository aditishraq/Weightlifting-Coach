/* Elite reference ranges from knowledge/good-lift.md (sources there), and this lift's matching measures.
   Ranges are mean ± SD from elite competition lifts; they describe elite lifts, they aren't targets. No DOM. */

// mean, sd, unit, the study (see knowledge/good-lift.md), and what it means
export const REFERENCE = {
  snatch: [
    { id: 'sweepBack', label: 'First-pull sweep back', mean: 6, sd: 3, unit: 'cm', source: 'Cunanan 2020 (X1)', what: 'how far the bar moves back toward you between lift-off and peak bar speed' },
    { id: 'loop', label: 'Loop at the hips', mean: 6, sd: 3, unit: 'cm', source: 'Cunanan 2020 (X2)', what: 'from the bar\'s rearmost point to its most forward point before the peak' },
    { id: 'catchBack', label: 'Catch behind the start', mean: 10, sd: 8.5, unit: 'cm', source: 'Cunanan 2020 (Xnet)', what: 'how far behind where it left the floor the bar is caught' },
    { id: 'pullHeight', label: 'Pull height', mean: 100, sd: 9, unit: 'cm', source: 'Cunanan 2020 (Ymax)', what: 'the bar\'s highest point above where it started' },
    { id: 'drop', label: 'Drop to the catch', mean: 15.5, sd: 4, unit: 'cm', source: 'Cunanan 2020 (Ydrop)', what: 'from the highest point to where the bar stops in the catch' },
    { id: 'catchRel', label: 'Catch height', mean: 84.5, sd: 4, unit: '% of peak', source: 'Cunanan 2020 (Catchrel)', what: 'catch height as a share of the highest point; independent of the camera\'s scale' },
    { id: 'peakSpeed', label: 'Peak bar speed', mean: 1.84, sd: 0.12, unit: 'm/s', source: 'Cunanan 2020 (Vmax)', what: 'elite lifts near their best; lighter lifts are usually faster' },
  ],
  jerk: [
    { id: 'driveSpeed', label: 'Jerk drive speed', mean: 1.53, sd: 0.1, unit: 'm/s', source: 'Liu 2024', what: 'peak bar speed driving out of the dip' },
  ],
};

/* This lift's measures. a = analyse(), ph = barPhases(), pts = pathPoints(), c = cm per px, facing = +1/−1,
   ratio = plate width ÷ height (horizontal distances read short by it when the camera is turned). */
export function measures(a, ph, pts, c, facing, ratio = 1) {
  const out = {};
  if (!a || !ph || ph.liftoff == null) return out;
  const x = i => (pts[i].x - pts[a.start].x) * facing * c / (ratio || 1), h = i => ph.h(i), lo = ph.liftoff;
  // first pull to peak speed: the rearmost point, then the most forward point after it, before the peak
  const end = a.vIdx ?? a.peak;
  let back = lo; for (let i = lo; i <= end; i++) if (pts[i] && x(i) < x(back)) back = i;
  let fwd = back; for (let i = back; i <= a.peak; i++) if (pts[i] && x(i) > x(fwd)) fwd = i;
  out.sweepBack = Math.max(0, -x(back));
  out.loop = x(fwd) - x(back);
  out.catchBack = -x(a.catchIdx);
  out.pullHeight = h(a.peak);
  out.drop = h(a.peak) - h(a.catchIdx);
  out.catchRel = h(a.peak) > 0 ? h(a.catchIdx) / h(a.peak) * 100 : null;
  out.peakSpeed = a.vMax;
  if (a.jerk && pts[a.jerk.dipBottom].vy != null) {
    let v = null; for (let i = a.jerk.dipBottom; i <= a.jerk.top; i++) if (pts[i]) { const u = -pts[i].vy * c / 100; if (v == null || u > v) v = u; }
    out.driveSpeed = v;
    out.dipDepth = h(a.jerk.dipStart) - h(a.jerk.dipBottom);
  }
  return out;
}

/* Rows comparing this lift with the elite ranges: { ...reference, value, z, where } where = within | below |
   above (beyond one SD). Only lifts with published ranges: the snatch, and the jerk of a clean & jerk. */
export function compare(lift, m) {
  const refs = [...(lift === 'snatch' ? REFERENCE.snatch : []), ...(lift === 'cj' ? REFERENCE.jerk : [])];
  return refs.filter(r => m[r.id] != null && isFinite(m[r.id])).map(r => {
    const z = (m[r.id] - r.mean) / r.sd;
    return { ...r, value: m[r.id], z, where: Math.abs(z) <= 1 ? 'within' : z < 0 ? 'below' : 'above' };
  });
}
