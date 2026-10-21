/* Compares result files for a clip with no ground truth, using the web app's own analysis:
     node --import ./tests/dom-stub.js tests/compare-results.js samples/a.json samples/b.json ...
   Prints each file's readout figures, then the frame-by-frame distance between each file's smoothed path and
   the first file's, from lift-off to the end of the shorter track. */
import { readFileSync } from 'node:fs';
import { S } from '../js/state.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from '../js/path.js';

function load(file) {
  const res = JSON.parse(readFileSync(file, 'utf8'));
  Object.assign(S, { src: { fps: res.video.fps }, radius: res.plate.radiusPx, lift: res.lift, facing: res.facing, points: [], times: [], smooth: true, kg: null });
  res.points.forEach((p, j) => { if (p) S.points[res.first + j] = { x: p[0], y: p[1], score: 1, ...(p[2] ? { low: true } : {}) }; });
  (res.times || []).forEach((t, j) => { if (t != null) S.times[res.first + j] = t; });
  const pts = pathPoints(), a = analyse(pts), ph = barPhases(pts), c = cmPerPx();
  return { file: file.split('/').pop(), res, pts, a, ph, c, t: i => timeOf(i) };
}

const runs = process.argv.slice(2).map(load), f1 = x => x == null ? '–' : x.toFixed(1), f2 = x => x == null ? '–' : x.toFixed(2);
const rows = [
  ['plate radius px', r => f1(r.res.plate.radiusPx)], ['axis ratio', r => f2(r.res.plate.axisRatio)],
  ['frames tracked', r => `${r.pts.filter(Boolean).length} (${r.res.points.filter(p => p && p[2]).length} low)`],
  ['lift-off / peak / received / catch frame', r => `${r.ph.liftoff} / ${r.a.peak} / ${r.a.receive} / ${r.a.catchIdx}`],
  ['pull height cm', r => f1(r.a.height * r.c)], ['drop to catch / ride down cm', r => `${f1(r.a.drop * r.c)} / ${f1(r.a.rideDown * r.c)}`],
  ['toward / away cm', r => `${f1(r.a.toward * r.c)} / ${f1(r.a.away * r.c)}`], ['catch vs start cm', r => f1(r.a.catchD * r.c)],
  ['peak velocity m/s (frame)', r => `${f2(r.a.vMax)} (${r.a.vIdx})`], ['pull / turnover s', r => `${f2(r.a.pullTime)} / ${f2(r.a.turnoverTime)}`],
  ['time used', r => `${r.res.producer.seconds} s`],
];
console.log(['', ...runs.map(r => r.file)].join(' | '));
for (const [name, fn] of rows) console.log([name, ...runs.map(fn)].join(' | '));

const A = runs[0];
for (const B of runs.slice(1)) {
  const lo = Math.min(A.ph.liftoff, B.ph.liftoff), end = Math.min(A.pts.length, B.pts.length) - 1;
  // compare shapes, so line the two paths up at the start (each mark may sit on a slightly different point)
  const ox = B.pts[A.ph.first].x - A.pts[A.ph.first].x, oy = B.pts[A.ph.first].y - A.pts[A.ph.first].y;
  const d = [];
  for (let i = lo; i <= end; i++) if (A.pts[i] && B.pts[i]) d.push([i, Math.hypot(B.pts[i].x - ox - A.pts[i].x, B.pts[i].y - oy - A.pts[i].y) * A.c]);
  const rms = Math.sqrt(d.reduce((s, [, v]) => s + v * v, 0) / d.length), worst = d.reduce((m, q) => q[1] > m[1] ? q : m);
  let tmax = 0; for (let i = 0; i <= end; i++) tmax = Math.max(tmax, Math.abs(A.t(i) - B.t(i)));
  console.log(`${B.file} vs ${A.file}: start offset (${f1(ox)}, ${f1(oy)}) px; path difference from frame ${lo}: RMS ${f2(rms)} cm, worst ${f2(worst[1])} cm at frame ${worst[0]}; frame times differ by up to ${(tmax * 1000).toFixed(1)} ms`);
}
