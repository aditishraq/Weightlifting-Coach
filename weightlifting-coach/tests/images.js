/* Synthetic grey images for the unit tests. */

export const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);

/* Grey plate: dark rim, bright face with a ring and one rotating bar, steel hub; anti-aliased by coverage.
   ratio < 1 squeezes it horizontally (camera turned away from side-on). Draws onto base (a previous image) if given. */
export function plateImage(w, h, cx, cy, R, theta = 0, noise = 0, bg = 60, ratio = 1, base = null) {
  const g = base ? Float32Array.from(base.g) : new Float32Array(w * h), cov = d => Math.min(1, Math.max(0, 0.5 - d)), cs = Math.cos(theta), sn = Math.sin(theta);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x - cx) / ratio, v = y - cy, r = Math.hypot(u, v), pu = u * cs + v * sn, pv = -u * sn + v * cs;
    let c = 25;
    c += (170 - c) * cov(r - 0.93 * R);
    c += (110 - c) * cov(Math.abs(r - 0.62 * R) - 1.5);
    c += (245 - c) * cov(Math.max(Math.abs(pu) - 0.2 * R, Math.abs(pv - 0.45 * R) - 0.06 * R));
    c += (200 - c) * cov(r - 0.3 * R);
    c += (90 - c) * cov(r - 0.12 * R);
    const back = base ? g[y * w + x] : bg, a = cov((r - R) * ratio);
    g[y * w + x] = back + (c - back) * a + (noise && !base ? noise * (rand() + rand() + rand() - 1.5) * 2 : 0);
  }
  return { g, w, h, sx: 1, sy: 1 };
}

