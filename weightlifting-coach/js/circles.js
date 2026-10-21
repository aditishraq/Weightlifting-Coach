/* Gradient Hough circle search on a grey image { g, w, h }. No DOM. */

/* Circles with radius in [rMin, rMax] (px) whose centre lies in box { x0, y0, x1, y1 }, best first:
   [{ x, y, r, score }], score = votes per pixel of circumference (edges are a few px thick, so it can pass 1). */
export function houghCircles(img, box, rMin, rMax, maxN = 5) {
  const { g, w, h } = img;
  const r0 = Math.max(2, Math.floor(rMin)), r1 = Math.max(r0, Math.ceil(rMax)), nr = r1 - r0 + 1;
  // edges can sit up to rMax outside the centre box
  const X0 = Math.max(1, Math.floor(box.x0 - r1)), Y0 = Math.max(1, Math.floor(box.y0 - r1));
  const X1 = Math.min(w - 2, Math.ceil(box.x1 + r1)), Y1 = Math.min(h - 2, Math.ceil(box.y1 + r1));
  const cx0 = Math.max(0, Math.floor(box.x0)), cy0 = Math.max(0, Math.floor(box.y0));
  const bw = Math.min(w, Math.ceil(box.x1)) - cx0 + 1, bh = Math.min(h, Math.ceil(box.y1)) - cy0 + 1;
  if (X1 <= X0 || Y1 <= Y0 || bw < 1 || bh < 1) return [];
  const edges = []; let mx = 0;
  for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
    const o = y * w + x;
    const gx = g[o - w + 1] + 2 * g[o + 1] + g[o + w + 1] - g[o - w - 1] - 2 * g[o - 1] - g[o + w - 1];
    const gy = g[o + w - 1] + 2 * g[o + w] + g[o + w + 1] - g[o - w - 1] - 2 * g[o - w] - g[o - w + 1];
    const m = Math.hypot(gx, gy);
    if (m > 40) { edges.push(x, y, gx / m, gy / m, m); if (m > mx) mx = m; }
  }
  const thr = Math.max(40, 0.2 * mx), acc = new Float32Array(nr * bw * bh);
  for (let e = 0; e < edges.length; e += 5) {
    if (edges[e + 4] < thr) continue;
    const x = edges[e], y = edges[e + 1], ux = edges[e + 2], uy = edges[e + 3];
    for (let k = 0; k < nr; k++) {
      const r = r0 + k;
      for (const s of [-1, 1]) {   // the plate can be lighter or darker than what is around it
        const cx = Math.round(x + s * r * ux) - cx0, cy = Math.round(y + s * r * uy) - cy0;
        if (cx >= 0 && cy >= 0 && cx < bw && cy < bh) acc[(k * bh + cy) * bw + cx]++;
      }
    }
  }
  // 3×3 sum per radius (votes scatter by a pixel), normalised by the circumference
  const cand = [];
  for (let k = 0; k < nr; k++) {
    const r = r0 + k, norm = 2 * Math.PI * r;
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += acc[(k * bh + y + j) * bw + x + i];
      if (s / norm > 0.25) cand.push({ x: x + cx0, y: y + cy0, r, score: s / norm });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of cand) {
    // same centre and similar radius only: a plate's hub and rim share a centre and both should survive
    if (out.some(o => Math.hypot(o.x - c.x, o.y - c.y) < r0 / 2 && Math.abs(o.r - c.r) < 0.2 * c.r)) continue;
    out.push(c); if (out.length >= maxN) break;
  }
  return out;
}
