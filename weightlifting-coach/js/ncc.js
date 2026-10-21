/* Bar-end tracking on grey images { g: Float32Array, w, h }. No DOM, so it runs in a Worker and under Node. */
import { houghCircles } from './circles.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ts × ts patch centred on the sub-pixel point (cx, cy), bilinear. Null if it runs off the image. */
export function cutPatch(img, cx, cy, ts) {
  const half = ts >> 1, x0 = cx - half, y0 = cy - half;
  if (x0 < 0 || y0 < 0 || x0 + ts > img.w - 1 || y0 + ts > img.h - 1) return null;
  const ix = Math.floor(x0), iy = Math.floor(y0), fx = x0 - ix, fy = y0 - iy, W = img.w, g = img.g;
  const out = new Float32Array(ts * ts);
  for (let j = 0, k = 0; j < ts; j++) {
    const r0 = (iy + j) * W + ix, r1 = r0 + W;
    for (let i = 0; i < ts; i++, k++)
      out[k] = (1 - fy) * ((1 - fx) * g[r0 + i] + fx * g[r0 + i + 1]) + fy * ((1 - fx) * g[r1 + i] + fx * g[r1 + i + 1]);
  }
  return out;
}

export function prepTpl(raw) {
  let m = 0; for (const v of raw) m += v; m /= raw.length;
  const t = new Float32Array(raw.length); let n2 = 0;
  for (let k = 0; k < raw.length; k++) { t[k] = raw[k] - m; n2 += t[k] * t[k]; }
  return { t, n2 };
}

/* Normalised cross-correlation of the template over a (2R+1)² window around (px, py), best match refined to
   sub-pixel by a parabola through its neighbours. Window sums Σv and Σv² come from summed-area tables. */
export function match(img, tpl, ts, px, py, R) {
  const half = ts >> 1, n = ts * ts, W = img.w, g = img.g, t = tpl.t;
  const cx = Math.round(px), cy = Math.round(py), size = 2 * R + 1;
  // summed-area tables over the region the window can touch
  const ax = clamp(cx - R - half, 0, W), ay = clamp(cy - R - half, 0, img.h);
  const bx = clamp(cx + R - half + ts, 0, W), by = clamp(cy + R - half + ts, 0, img.h);
  const sw = bx - ax + 1, sh = by - ay + 1;
  if (sw < 2 || sh < 2) return null;
  const S1 = new Float64Array(sw * sh), S2 = new Float64Array(sw * sh);
  for (let y = 1; y < sh; y++) {
    let r1 = 0, r2 = 0;
    for (let x = 1; x < sw; x++) {
      const v = g[(ay + y - 1) * W + ax + x - 1]; r1 += v; r2 += v * v;
      S1[y * sw + x] = S1[(y - 1) * sw + x] + r1; S2[y * sw + x] = S2[(y - 1) * sw + x] + r2;
    }
  }
  const box = (S, x0, y0) => { const a = (y0 - ay) * sw + x0 - ax, b = a + ts * sw; return S[b + ts] - S[b] - S[a + ts] + S[a]; };
  const sc = new Float32Array(size * size).fill(-2);
  let best = -2, bi = -1;
  for (let dy = -R; dy <= R; dy++) {
    const y0 = cy + dy - half; if (y0 < 0 || y0 + ts > img.h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x0 = cx + dx - half; if (x0 < 0 || x0 + ts > W) continue;
      const s = box(S1, x0, y0), vi = box(S2, x0, y0) - s * s / n;
      if (vi < 1e-3) continue;
      let c = 0, k = 0;
      for (let j = 0; j < ts; j++) {
        let r = (y0 + j) * W + x0;
        for (let i = 0; i < ts; i++) c += g[r++] * t[k++];
      }
      const score = c / Math.sqrt(vi * tpl.n2);
      const idx = (dy + R) * size + dx + R;
      sc[idx] = score; if (score > best) { best = score; bi = idx; }
    }
  }
  if (bi < 0) return null;
  const by2 = Math.floor(bi / size), bx2 = bi % size;
  const sub = (l, r) => { if (l <= -2 || r <= -2) return 0; const den = l - 2 * best + r; return den < 0 ? clamp(0.5 * (l - r) / den, -0.5, 0.5) : 0; };
  const ox = bx2 > 0 && bx2 < size - 1 ? sub(sc[bi - 1], sc[bi + 1]) : 0;
  const oy = by2 > 0 && by2 < size - 1 ? sub(sc[bi - size], sc[bi + size]) : 0;
  return { x: cx + bx2 - R + ox, y: cy + by2 - R + oy, score: best };
}

/* Sub-pixel plate centre near (cx, cy) on a full-resolution crop { g, w, h, x0, y0 } (x0, y0 = crop origin in the
   frame). The point closest, in least squares, to every edge-gradient line inside the plate whose direction is
   close to radial: the rim, the face rings and the hub all point at the centre, whatever their radius and however
   the plate has turned. Weighted by gradient² and iterated from the start point. Null if too few edges. */
export function radialCenter(roi, cx, cy, R) {
  const { g, w, h, x0, y0 } = roi, cosMin = Math.cos(20 * Math.PI / 180);
  let x = cx, y = cy;
  for (let it = 0; it < 4; it++) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, n = 0, gmax = 0;
    const lo = Math.max(1, Math.floor(y - R - 3 - y0)), hi = Math.min(h - 2, Math.ceil(y + R + 3 - y0));
    const le = Math.max(1, Math.floor(x - R - 3 - x0)), ri = Math.min(w - 2, Math.ceil(x + R + 3 - x0));
    for (let pass = 0; pass < 2; pass++) for (let j = lo; j <= hi; j++) for (let i = le; i <= ri; i++) {
      const px = i + x0, py = j + y0, dx = px - x, dy = py - y, rr = Math.hypot(dx, dy);
      if (rr < 0.08 * R || rr > R + 3) continue;
      const o = j * w + i;
      const gx = g[o - w + 1] + 2 * g[o + 1] + g[o + w + 1] - g[o - w - 1] - 2 * g[o - 1] - g[o + w - 1];
      const gy = g[o + w - 1] + 2 * g[o + w] + g[o + w + 1] - g[o - w - 1] - 2 * g[o - w] - g[o - w + 1];
      const m2 = gx * gx + gy * gy;
      if (pass === 0) { if (m2 > gmax) gmax = m2; continue; }
      if (m2 < 0.01 * gmax) continue;
      const m = Math.sqrt(m2);
      if (Math.abs(gx * dx + gy * dy) < cosMin * m * rr) continue;
      // normal of the gradient line through (px, py)
      const nx = -gy / m, ny = gx / m, d = nx * px + ny * py;
      a11 += m2 * nx * nx; a12 += m2 * nx * ny; a22 += m2 * ny * ny; b1 += m2 * nx * d; b2 += m2 * ny * d; n++;
    }
    const det = a11 * a22 - a12 * a12;
    if (n < 30 || det <= 0) return null;
    const nx2 = (a22 * b1 - a12 * b2) / det, ny2 = (a11 * b2 - a12 * b1) / det;
    const step = Math.hypot(nx2 - x, ny2 - y);
    x = nx2; y = ny2;
    if (step > 0.3 * R) return null;
    if (step < 0.01) break;
  }
  return Math.hypot(x - cx, y - cy) < 0.3 * R ? { x, y } : null;
}

/* Frame-to-frame tracker. cfg is CONFIG.tracking plus { fps }. Work images carry their scale { sx, sy } to
   frame pixels; every position in and out is in frame pixels. Per frame: step(work image), then, unless that
   frame was low or lost, finish(full-resolution crop around the match, or null). */
export class BarTracker {
  constructor(cfg) { this.cfg = cfg; }

  /* Returns an error message, or null when ready. */
  init(img, x, y, ts, radius) {
    const raw = cutPatch(img, x * img.sx, y * img.sy, ts);
    if (!raw) return 'The marked circle runs off the edge of the frame. Make it smaller or mark a point further in.';
    this.tpl0 = prepTpl(raw);
    if (this.tpl0.n2 < ts * ts * 4) return 'The marked spot has almost no detail to follow. Centre the circle on the sleeve end and plate.';
    const p = { x: x * img.sx, y: y * img.sy };
    Object.assign(this, { raw, ts, radius, rw: radius * img.sx, tpl: this.tpl0, prev: p, vel: { x: 0, y: 0 }, low: 0, last: p, sinceGood: 0 });
    return null;
  }

  best(img, x, y, R) {
    const c = this.cfg;
    let m = match(img, this.tpl, this.ts, x, y, R);
    if (!m || m.score < c.goodScore) {
      const m0 = match(img, this.tpl0, this.ts, x, y, R);
      if (m0 && (!m || m0.score > m.score)) m = m0;
    }
    return m;
  }

  /* { x, y, score, low?, refound? } in frame pixels, or { lost: true } once re-finding has given up. */
  step(img) {
    const c = this.cfg, ts = this.ts, rw = this.rw;
    const pred = { x: this.prev.x + this.vel.x, y: this.prev.y + this.vel.y };
    // physical gate (work px) for k frames since the last good match
    const k = this.sinceGood + 1, dt = k / c.fps, pxPerM = rw / 0.225;
    const gate = (0.5 * c.maxAccelMs2 * dt * dt + c.gateSlackCm / 100) * pxPerM;
    const inGate = p => p && Math.hypot(p.x - pred.x, p.y - pred.y) <= gate;
    let m = this.best(img, pred.x, pred.y, Math.min(48, Math.ceil(gate) + 1)), refound = false;
    // coming out of a gap the gate is wide, so a match has to be a good one
    const floor = this.sinceGood ? Math.max(c.goodScore, c.refindScore) : c.lowScore;
    if (!inGate(m) || m.score < floor) m = null;
    if (!m && this.low >= 1) {
      // circle search inside the gate, at least a plate radius and at most six
      const reach = Math.min(6 * rw, Math.max(rw, gate));
      const box = { x0: pred.x - reach, y0: pred.y - reach, x1: pred.x + reach, y1: pred.y + reach };
      for (const cand of houghCircles(img, box, rw * 0.8, rw * 1.15, 5)) {
        const v = this.best(img, cand.x, cand.y, 3);
        if (v && v.score >= c.refindScore && Math.hypot(v.x - pred.x, v.y - pred.y) <= reach && (!m || v.score > m.score)) { m = v; refound = true; }
      }
    }
    if (!m) {
      this.low++; this.sinceGood++;
      if (this.low >= c.lostFrames + Math.round(c.refindSeconds * c.fps)) return { lost: true };
      this.prev = pred;
      return { x: pred.x / img.sx, y: pred.y / img.sy, score: m ? m.score : 0, low: true };
    }
    this.pending = { img, m, refound };
    return { x: m.x / img.sx, y: m.y / img.sy, score: m.score, refound };
  }

  /* Accepts the last match, refined on the crop { g, w, h, x0, y0 } when given. Returns the final position. */
  finish(roi) {
    const c = this.cfg, { img, m, refound } = this.pending; this.pending = null;
    let x = m.x, y = m.y;
    const f = roi && radialCenter(roi, m.x / img.sx, m.y / img.sy, this.radius);
    if (f) { x = f.x * img.sx; y = f.y * img.sy; }
    // after a gap, the velocity is the average since the last good match
    const k = this.sinceGood + 1;
    this.vel = { x: (x - this.last.x) / k, y: (y - this.last.y) / k };
    this.prev = this.last = { x, y };
    this.low = 0; this.sinceGood = 0;
    if (m.score > c.updateScore && !refound) {
      const np = cutPatch(img, x, y, this.ts);
      if (np) { for (let q = 0; q < this.raw.length; q++) this.raw[q] = (1 - c.updateRate) * this.raw[q] + c.updateRate * np[q]; this.tpl = prepTpl(this.raw); }
    }
    return { x: x / img.sx, y: y / img.sy, refined: !!f };
  }
}
