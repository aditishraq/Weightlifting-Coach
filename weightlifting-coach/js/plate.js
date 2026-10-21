/* Automatic plate detection on one frame. No DOM: the caller supplies a small grey work image and a function
   that crops the full-resolution frame, so this runs under Node too. */
import { houghCircles } from './circles.js';
import { radialCenter } from './ncc.js';
import { CONFIG } from './config.js';

const sample = (roi, x, y) => {   // bilinear, frame coordinates
  const u = x - roi.x0, v = y - roi.y0, i = Math.floor(u), j = Math.floor(v);
  if (i < 0 || j < 0 || i >= roi.w - 1 || j >= roi.h - 1) return null;
  const fx = u - i, fy = v - j, o = j * roi.w + i, g = roi.g;
  return (1 - fy) * ((1 - fx) * g[o] + fx * g[o + 1]) + fy * ((1 - fx) * g[o + roi.w] + fx * g[o + roi.w + 1]);
};

/* Axis-aligned ellipse (x−x0)²/a² + (y−y0)²/b² = 1 through weighted points, as A x² + B y² + C x + D y = 1. */
function ellipseLS(P, w, ox, oy, sc) {
  // in coordinates centred on (ox, oy) and scaled by sc, so the normal equations stay well conditioned
  const M = Array.from({ length: 4 }, () => new Float64Array(5));
  for (let k = 0; k < P.length; k++) {
    if (!w[k]) continue;
    const x = (P[k][0] - ox) / sc, y = (P[k][1] - oy) / sc, f = [x * x, y * y, x, y];
    for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) M[i][j] += w[k] * f[i] * f[j]; M[i][4] += w[k] * f[i]; }
  }
  for (let c = 0; c < 4; c++) {   // Gauss–Jordan with partial pivoting
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-30) return null;
    for (let r = 0; r < 4; r++) if (r !== c) { const q = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= q * M[c][j]; }
  }
  const [A, B, C, D] = M.map((row, i) => row[4] / row[i]);
  if (!(A > 0 && B > 0)) return null;
  const x0 = -C / (2 * A), y0 = -D / (2 * B), F = 1 + C * C / (4 * A) + D * D / (4 * B);
  if (!(F > 0)) return null;
  return { x: ox + x0 * sc, y: oy + y0 * sc, a: Math.sqrt(F / A) * sc, b: Math.sqrt(F / B) * sc };
}

/* Sub-pixel plate outline near the circle (cx, cy, r) on a full-resolution crop { g, w, h, x0, y0 }.
   Along K rays from the centre, finds up to six clear edges between 0.7 r and 1.6 r, each refined with a
   parabola. The centre comes from the radial symmetry of all the plate's rings (radialCenter); the outline
   is the best-supported ring by RANSAC over the rays, refined with Tukey reweighting, and then the largest
   concentric copy of it that the edges support, which is the outer rubber.
   Returns { x, y, r, ratio, a, b, support, rimSupport, rms }: r = the larger semi-axis (the true plate radius
   when the camera is turned a little), ratio = smaller / larger, support = share of rays on the best ring,
   rimSupport = share on the outer rubber. */
export function fitPlateEdges(roi, cx, cy, r, K = 96) {
  const centre = radialCenter(roi, cx, cy, 1.1 * r);
  // edge candidates along each ray: local maxima of the intensity change above the crop's noise level
  // out to 1.6 r so that a seed on a face ring or the hub-side still reaches the rubber
  const rays = [], all = [], step = 0.5, s0 = 0.7 * r, n = Math.ceil((0.9 * r) / step);
  for (let k = 0; k < K; k++) {
    const t = 2 * Math.PI * k / K, ux = Math.cos(t), uy = Math.sin(t), prof = [];
    for (let i = -2; i <= n + 2; i++) prof.push(sample(roi, cx + (s0 + i * step) * ux, cy + (s0 + i * step) * uy));
    if (prof.some(v => v == null)) continue;
    const d = []; for (let i = 2; i <= n + 2; i++) { d.push(Math.abs(prof[i + 2] - prof[i - 2])); all.push(d[d.length - 1]); }
    rays.push({ k, ux, uy, d });
  }
  if (rays.length < K * 0.3) return null;
  all.sort((p, q) => p - q);
  const floor = Math.max(6, 4 * all[all.length >> 1]);
  const peaks = rays.map(({ k: ray, ux, uy, d }) => {
    const mx = Math.max(...d), out = [];
    for (let i = 1; i < d.length - 1; i++) if (d[i] >= Math.max(floor, 0.04 * mx) && d[i] >= d[i - 1] && d[i] > d[i + 1]) {
      const den = d[i - 1] - 2 * d[i] + d[i + 1], off = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (d[i - 1] - d[i + 1]) / den)) : 0;
      const s = s0 + (i + off) * step;
      out.push({ x: cx + s * ux, y: cy + s * uy, m: d[i], ray });
    }
    return out.sort((p, q) => q.m - p.m).slice(0, 6);   // the six strongest; a dark rim can be faint
  }).filter(p => p.length);
  if (peaks.length < K * 0.3) return null;
  const resid = (e, p) => (Math.hypot((p.x - e.x) / e.a, (p.y - e.y) / e.b) - 1) * Math.sqrt(e.a * e.b);
  const near = (e, ray) => ray.reduce((o, q) => Math.abs(resid(e, q)) < Math.abs(resid(e, o)) ? q : o);
  const tolOf = e => Math.max(1.5, 0.03 * Math.max(e.a, e.b));
  const count = e => { const tol = tolOf(e); let n = 0; for (const ray of peaks) if (Math.abs(resid(e, near(e, ray))) < tol) n++; return n; };
  let seed = 12345; const rnd = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const okShape = e => { const R = Math.max(e.a, e.b); return Math.min(e.a, e.b) / R >= 0.6 && R >= 0.7 * r && R <= 1.6 * r; };
  // Best-supported ring by RANSAC. With the centre known (radial symmetry of all the rings), only the two
  // semi-axes are free: cos²θ / a² + sin²θ / b² = 1 / s² is linear in 1/a², 1/b², so two edges fix a shape and
  // edges from the body or the bar can't pull the centre aside. Without it, four edges fix a full ellipse.
  const c0 = centre && Math.hypot(centre.x - cx, centre.y - cy) < 0.35 * r ? centre : null;
  let best = null;
  for (let it = 0; it < 300; it++) {
    let e;
    if (c0) {
      const i = rnd(peaks.length), j = rnd(peaks.length); if (i === j) continue;
      const P = peaks[i][rnd(peaks[i].length)], Q = peaks[j][rnd(peaks[j].length)];
      const row = p => { const dx = p.x - c0.x, dy = p.y - c0.y, s2 = dx * dx + dy * dy; return [dx * dx / s2, dy * dy / s2, 1 / s2]; };
      const [p1, p2, p3] = row(P), [q1, q2, q3] = row(Q), det = p1 * q2 - p2 * q1;
      if (Math.abs(det) < 0.2) continue;   // too close in angle to separate the axes
      const u = (p3 * q2 - p2 * q3) / det, v = (p1 * q3 - p3 * q1) / det;
      if (!(u > 0 && v > 0)) continue;
      e = { x: c0.x, y: c0.y, a: 1 / Math.sqrt(u), b: 1 / Math.sqrt(v) };
    } else {
      const rs = new Set(); while (rs.size < 4) rs.add(rnd(peaks.length));
      e = ellipseLS([...rs].map(i => { const ray = peaks[i]; const q = ray[rnd(ray.length)]; return [q.x, q.y]; }), [1, 1, 1, 1], cx, cy, r);
      if (!e || Math.hypot(e.x - cx, e.y - cy) > 0.35 * r) continue;
    }
    if (!okShape(e)) continue;
    const n = count(e);
    if (!best || n > best.n) best = { e, n };
  }
  if (!best) return null;
  let e = best.e, pick = peaks.map(ray => near(e, ray)), w;
  for (let it = 0; it < 6; it++) {
    const c = tolOf(e) * 4.685 / 2;   // Tukey: ~3 % of the radius is an inlier
    w = pick.map(p => { const res = resid(e, p); return Math.abs(res) < c ? (1 - (res / c) ** 2) ** 2 : 0; });
    let f;
    if (c0) {   // weighted least squares for 1/a², 1/b² with the centre fixed
      let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
      pick.forEach((p, k) => {
        const dx = p.x - c0.x, dy = p.y - c0.y, s2 = dx * dx + dy * dy, x1 = dx * dx / s2, x2 = dy * dy / s2, yv = 1 / s2, wk = w[k] * s2 * s2;
        s11 += wk * x1 * x1; s12 += wk * x1 * x2; s22 += wk * x2 * x2; t1 += wk * x1 * yv; t2 += wk * x2 * yv;
      });
      const det = s11 * s22 - s12 * s12, u = (t1 * s22 - s12 * t2) / det, v = (s11 * t2 - s12 * t1) / det;
      f = det > 0 && u > 0 && v > 0 ? { x: c0.x, y: c0.y, a: 1 / Math.sqrt(u), b: 1 / Math.sqrt(v) } : null;
    } else f = ellipseLS(pick.map(p => [p.x, p.y]), w, cx, cy, r);
    if (!f) return null;
    e = f; pick = peaks.map(ray => near(e, ray));
  }
  const tol = tolOf(e); let support = 0;
  for (const p of pick) if (Math.abs(resid(e, p)) < tol) support++;
  // That ring gives the centre and the shape. It may be a face ring inside the rubber, and the rubber can be
  // hard to see against dark clothing, so look for the largest copy of the same ellipse that a fair share of
  // rays have an edge on. Count opposite pairs of rays, not single rays: the face's edge is there all round,
  // but when the camera isn't side-on the plate's side wall shows beyond it on one side only, and taking that
  // for the rim makes the plate look bigger and every distance shorter.
  const q = new Array(K).fill(null).map(() => []);
  for (const ray of peaks) for (const p of ray) q[p.ray].push(Math.hypot((p.x - e.x) / e.a, (p.y - e.y) / e.b));
  const band = Math.max(0.012, 1.5 / Math.max(e.a, e.b)), half = K >> 1;
  const on = (k, j) => q[j].some(v => Math.abs(v - k) < band);
  let scale = 1, rim = support;
  for (let k = 1.35; k > 0.85; k -= 0.0025) {
    let n = 0; for (let j = 0; j < half; j++) if (on(k, j) && on(k, j + half)) n++;
    if (n >= Math.max(0.2 * half, 0.3 * support / 2)) {
      // centre of that cluster, from the paired rays
      let sq = 0, m = 0;
      for (let j = 0; j < half; j++) if (on(k, j) && on(k, j + half)) for (const jj of [j, j + half]) for (const v of q[jj]) if (Math.abs(v - k) < 2 * band) { sq += v; m++; }
      scale = sq / m; rim = 2 * n; break;
    }
  }
  let a2 = e.a * scale, b2 = e.b * scale;
  // The rim's own shape, from its paired edge points with the centre fixed (cos²t / a² + sin²t / b² = 1 / r²):
  // the inner ring that found the centre can be a little rounder than the face, e.g. a steel hub that stands
  // proud of it, and the width ÷ height decides whether bar-vs-body checks can be trusted.
  if (rim > 2 * support / 3 || scale !== 1) {
    let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0, nn = 0;
    const kk = scale;
    for (let j = 0; j < half; j++) {
      if (!(on(kk, j) && on(kk, j + half))) continue;
      for (const jj of [j, j + half]) {
        const qv = q[jj].reduce((o, v) => Math.abs(v - kk) < Math.abs(o - kk) ? v : o);
        const t = 2 * Math.PI * jj / K, ct = Math.cos(t), st = Math.sin(t);
        const rr = qv / Math.sqrt((ct / e.a) ** 2 + (st / e.b) ** 2);   // distance of that edge from the centre
        const x1 = ct * ct, x2 = st * st, y = 1 / (rr * rr);
        s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; t1 += x1 * y; t2 += x2 * y; nn++;
      }
    }
    const det = s11 * s22 - s12 * s12, u = (t1 * s22 - s12 * t2) / det, v = (s11 * t2 - s12 * t1) / det;
    if (nn >= 12 && det > 0 && u > 0 && v > 0) { a2 = 1 / Math.sqrt(u); b2 = 1 / Math.sqrt(v); }
  }
  const R = Math.max(a2, b2);
  let se = 0, ni = 0;
  for (const p of pick) { const res = resid(e, p); if (Math.abs(res) < tol) { se += res * res; ni++; } }
  return { x: e.x, y: e.y, r: R, a: a2, b: b2, ratio: Math.min(a2, b2) / R, support: support / K, rimSupport: rim / K, rms: ni ? Math.sqrt(se / ni) : Infinity };
}

/* Share of the face (0.45–0.85 r) that is clearly coloured, from an RGBA crop; coloured bumpers score high. */
function colourShare(roi, f) {
  if (!roi.rgba) return null;
  let n = 0, c = 0;
  for (let j = 0; j < roi.h; j += 2) for (let i = 0; i < roi.w; i += 2) {
    const q = Math.hypot((i + roi.x0 - f.x) / f.a, (j + roi.y0 - f.y) / f.b);
    if (q < 0.45 || q > 0.85) continue;
    const o = (j * roi.w + i) * 4, R = roi.rgba[o], G = roi.rgba[o + 1], B = roi.rgba[o + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    n++; if (mx > 60 && (mx - mn) / mx > 0.4) c++;
  }
  return n ? c / n : null;
}

/* Score in 0..1 from the fit and whatever prior is known: { expectedR, floorY, wrist: { x, y } }. */
export function scorePlate(f, prior = {}, colour = null) {
  const W = CONFIG.detect.weights, gauss = (d, s) => Math.exp(-0.5 * (d / s) ** 2);
  // outline: how much of it is there. Not how tightly it fits: the lifter's own plate always has the body
  // behind it, so it never fits as cleanly as a spare plate against a wall.
  const parts = { rim: [W.rim, Math.min(1, f.support / 0.85)] };
  if (prior.expectedR) parts.radius = [W.radius, gauss(f.r / prior.expectedR - 1, CONFIG.detect.radiusTol)];
  if (prior.floorY != null) parts.floor = [W.floor, gauss(f.y + f.b - prior.floorY, 0.08 * f.r + 2)];
  if (prior.wrist) parts.wrist = [W.wrist, gauss(Math.hypot(f.x - prior.wrist.x, f.y - prior.wrist.y), 0.8 * f.r)];
  if (colour != null) parts.colour = [W.colour, colour];
  let s = 0, n = 0;
  for (const [w, v] of Object.values(parts)) { s += w * v; n += w; }
  return { score: s / n, parts: Object.fromEntries(Object.entries(parts).map(([k, [, v]]) => [k, +v.toFixed(3)])) };
}

/* Finds the plate. work = grey image { g, w, h, sx, sy } (sx, sy = work px per frame px); crop(cx, cy, half)
   returns a full-resolution crop (optionally with rgba); W, H = frame size; prior as for scorePlate plus
   box = { x0, y0, x1, y1 } (frame px) to search for the centre in. Returns candidates, best first. */
export function detectPlate(work, crop, W, H, prior = {}) {
  const D = CONFIG.detect, s = work.sx;
  const rMin = prior.expectedR ? prior.expectedR * (1 - D.radiusRange) : D.minRadiusFrac * Math.min(W, H);
  const rMax = prior.expectedR ? prior.expectedR * (1 + D.radiusRange) : D.maxRadiusFrac * Math.min(W, H);
  const b = prior.box || { x0: 0, y0: 0, x1: W, y1: H };
  const circles = houghCircles(work, { x0: b.x0 * s, y0: b.y0 * work.sy, x1: b.x1 * s, y1: b.y1 * work.sy }, rMin * s, rMax * s, D.candidates);
  const out = [];
  for (const c of circles) {
    const cx = c.x / s, cy = c.y / work.sy, r = c.r / s;
    const roi = crop(cx, cy, 1.7 * r + 4);
    if (!roi) continue;
    // a Hough circle may sit on a ring inside the plate, so search outward from it
    const f = fitPlateEdges(roi, cx, cy, r);
    if (!f || f.r < rMin * 0.8 || f.r > rMax * 1.25) continue;
    if (f.x < 0 || f.y < 0 || f.x > W || f.y > H) continue;
    const roi2 = Math.hypot(f.x - cx, f.y - cy) > 0.1 * f.r || f.r > 1.3 * r ? crop(f.x, f.y, 1.7 * f.r + 4) : roi;
    // once more around the refined outline, kept if it is as well supported
    const g2 = roi2 && fitPlateEdges(roi2, f.x, f.y, f.r), f2 = g2 && g2.support >= 0.9 * f.support ? g2 : f;
    const sc = scorePlate(f2, prior, colourShare(roi2 || roi, f2));
    out.push({ ...f2, ...sc, hough: c });
  }
  // a hub or face ring shares the plate's centre; the plate is the outermost well-supported circle
  const inner = f => out.some(o => o !== f && o.support >= 0.5 && o.r > 1.25 * f.r && Math.hypot(o.x - f.x, o.y - f.y) < 0.15 * o.r);
  out.splice(0, out.length, ...out.filter(f => !inner(f)));
  if (!prior.expectedR && out.length) {
    // no idea of the lifter's size: the lifter's plate is usually the one nearest the camera, so the largest
    const big = Math.max(...out.map(f => f.r)), W2 = CONFIG.detect.weights;
    for (const f of out) {
      const n = Object.keys(f.parts).reduce((t, k) => t + W2[k], 0);
      f.parts.size = +(f.r / big).toFixed(3);
      f.score = (f.score * n + W2.size * f.parts.size) / (n + W2.size);
    }
  }
  // several Hough circles often lead to the same plate, some fitted to a face ring inside the rubber: keep the
  // largest tight, well-supported version (the rubber is the outermost ring), then rank by score
  const solid = f => f.support >= 0.4 && f.rms < 0.02 * f.r;
  out.sort((p, q) => (solid(q) - solid(p)) || q.r - p.r);
  const uniq = out.filter((f, i) => !out.slice(0, i).some(o => Math.hypot(o.x - f.x, o.y - f.y) < 0.3 * f.r && Math.abs(o.r / f.r - 1) < 0.15));
  return uniq.sort((p, q) => q.score - p.score);
}

/* Prior from MediaPipe pose landmarks (frame px, { x, y, v }) on the start frame: expected plate radius from
   the lifter's size, the floor line, the wrists (on the bar, so at the plate centre when filmed side-on) and a
   box around mid-foot and the wrists to search in. Null if the legs and torso aren't visible. */
const LM = { shoulder: [11, 12], wrist: [15, 16], hip: [23, 24], knee: [25, 26], ankle: [27, 28], heel: [29, 30], toe: [31, 32] };
export function platePrior(L) {
  if (!L) return null;
  const D = CONFIG.detect, seen = p => p && p.v > 0.3, dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let best = null;
  for (const s of [0, 1]) {
    const [sh, hp, kn, an] = ['shoulder', 'hip', 'knee', 'ankle'].map(n => L[LM[n][s]]);
    const vis = Math.min(sh.v, hp.v, kn.v, an.v);
    if (!best || vis > best.vis) best = { vis, len: dist(an, kn) + dist(kn, hp) + dist(hp, sh) };
  }
  if (best.vis < 0.3) return null;
  const height = best.len / D.legTorsoFrac, R = D.plateHeightFrac * height;
  const feet = [...LM.heel, ...LM.toe].map(i => L[i]).filter(seen);
  const floorY = feet.length ? Math.max(...feet.map(p => p.y)) : null;
  const wr = LM.wrist.map(i => L[i]).filter(p => p && p.v > 0.2);
  const wrist = wr.length ? { x: wr.reduce((a, p) => a + p.x, 0) / wr.length, y: wr.reduce((a, p) => a + p.y, 0) / wr.length } : null;
  const mf = [0, 1].map(s => [L[LM.heel[s]], L[LM.toe[s]]]).filter(([h, t]) => seen(h) && seen(t)).map(([h, t]) => (h.x + t.x) / 2);
  const midX = mf.length ? mf.reduce((a, x) => a + x, 0) / mf.length : null;
  const xs = [midX, wrist && wrist.x].filter(x => x != null);
  if (!xs.length) return null;
  const top = wrist ? wrist.y - 1.5 * R : floorY - 3 * R, bottom = floorY != null ? floorY + 0.2 * R : wrist.y + 1.5 * R;
  return {
    expectedR: R, height, floorY, wrist, midfootX: midX,
    box: { x0: Math.min(...xs) - 1.5 * R, x1: Math.max(...xs) + 1.5 * R, y0: top, y1: bottom },
  };
}
