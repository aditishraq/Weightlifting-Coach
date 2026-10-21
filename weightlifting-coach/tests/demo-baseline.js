/* Paste into the browser console after the built-in sample clip has tracked.
   Compares the tracked path to the clip's own ground truth (keyframes copied from demoSource in js/sources.js). */
const { S } = await import('/js/state.js'); const P = await import('/js/path.js');
const K = [[0,0,0],[0.4,0,0],[0.9,-0.045,0.28],[1.2,-0.03,0.55],[1.45,0.045,0.85],[1.65,0.02,1.02],[1.85,-0.035,0.93],[2.1,-0.03,0.87],[2.8,-0.03,0.87]];
const cr = (p0,p1,p2,p3,u) => 0.5*(2*p1+(-p0+p2)*u+(2*p0-5*p1+4*p2-p3)*u*u+(-p0+3*p1-3*p2+p3)*u*u*u);
function at(t) { if (t >= K[K.length-1][0]) return { x: K[K.length-1][1], h: K[K.length-1][2] }; let k = 0; while (t >= K[k+1][0]) k++; const u = (t-K[k][0])/(K[k+1][0]-K[k][0]); const a = K[Math.max(0,k-1)], b = K[k], c = K[k+1], d = K[Math.min(K.length-1,k+2)]; return { x: cr(a[1],b[1],c[1],d[1],u), h: Math.max(0, cr(a[2],b[2],c[2],d[2],u)) }; }
const out = {}, keep = S.smooth;
for (const sm of [false, true]) {
  S.smooth = sm; const pts = P.pathPoints(), a = P.analyse(pts), c = P.cmPerPx(), fps = S.src.fps;
  let se = 0, mx = 0, n = 0; const gtH = [];
  pts.forEach((p, i) => { if (!p) return; const g = at(i / fps); gtH[i] = g.h * 100; const e = Math.hypot(p.x - (380 + g.x * 436), p.y - (802 - g.h * 436)) * 100 / 436; se += e * e; mx = Math.max(mx, e); n++; });
  let gpk = 0; gtH.forEach((h, i) => { if (h > gtH[gpk]) gpk = i; });
  let gcat = gpk; for (let i = gpk + 1; i < gtH.length; i++) { if (gtH[i] < gtH[gcat]) gcat = i; else break; }
  const vmax = v => v.reduce((m, x, i) => x > m[0] ? [x, i] : m, [-1, 0]);
  const gv = gtH.map((h, i) => i ? (h - gtH[i-1]) * fps / 100 : 0), pv = pts.map((p, i) => i && p && pts[i-1] ? (pts[i-1].y - p.y) * c * fps / 100 : 0);
  out[sm ? 'smoothed' : 'raw'] = { rmsePosCm: Math.sqrt(se / n), maxPosCm: mx, pullHeightCm: a.height * c, gtPullHeightCm: gtH[gpk], dropCm: a.drop * c, gtDropCm: gtH[gpk] - gtH[gcat], peak: a.peak, gtPeak: gpk, catch: a.catchIdx, gtCatch: gcat, peakVel: vmax(pv), gtPeakVel: vmax(gv) };
}
S.smooth = keep; out
