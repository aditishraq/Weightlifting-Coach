/* Constant-acceleration Kalman filter with a Rauch–Tung–Striebel backward pass, one axis at a time.
   State [position, velocity, acceleration]; white-jerk process noise of spectral density q (units²/s⁵);
   frames may be unevenly spaced in time. A measurement variance of Infinity (or a null value) means
   "no measurement here": the frame still gets an estimate, bridged from its neighbours. */

const mul = (A, B) => {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  return C;
};
const tr = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const add = (A, B) => A.map((v, k) => v + B[k]);
const mv = (A, x) => [A[0] * x[0] + A[1] * x[1] + A[2] * x[2], A[3] * x[0] + A[4] * x[1] + A[5] * x[2], A[6] * x[0] + A[7] * x[1] + A[8] * x[2]];
function inv(A) {
  const [a, b, c, d, e, f, g, h, i] = A;
  const x = e * i - f * h, y = f * g - d * i, z = d * h - e * g, det = a * x + b * y + c * z;
  return [x, c * h - b * i, b * f - c * e, y, a * i - c * g, c * d - a * f, z, b * g - a * h, a * e - b * d].map(v => v / det);
}
const Fm = dt => [1, dt, dt * dt / 2, 0, 1, dt, 0, 0, 1];
const Qm = (dt, q) => {
  const d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
  return [d5 / 20, d4 / 8, d3 / 6, d4 / 8, d3 / 3, d2 / 2, d3 / 6, d2 / 2, dt].map(v => v * q);
};

/* t: times (s), z: values (null = none), r: measurement variances (number or array), q: jerk density.
   Returns [{ p, v, a }] for every index from the first to the last measurement, null outside. */
export function rts(t, z, r, q) {
  const n = z.length, R = i => (typeof r === 'number' ? r : r[i]);
  const has = i => z[i] != null && isFinite(R(i));
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (has(i)) { if (first < 0) first = i; last = i; }
  const out = new Array(n).fill(null);
  if (first < 0) return out;
  const xs = [], Ps = [], xp = [], Pp = [], Fs = [];
  let x = [z[first], 0, 0], P = [R(first), 0, 0, 0, 1e8, 0, 0, 0, 1e10];
  for (let i = first; i <= last; i++) {
    if (i > first) {
      const F = Fm(Math.max(0, t[i] - t[i - 1]));
      x = mv(F, x); P = add(mul(mul(F, P), tr(F)), Qm(Math.max(0, t[i] - t[i - 1]), q));
      Fs[i] = F;
    }
    xp[i] = x; Pp[i] = P;
    if (has(i)) {   // scalar update with H = [1 0 0]
      const s = P[0] + R(i), k = [P[0] / s, P[3] / s, P[6] / s], y = z[i] - x[0];
      x = [x[0] + k[0] * y, x[1] + k[1] * y, x[2] + k[2] * y];
      P = P.map((v, idx) => v - k[Math.floor(idx / 3)] * P[idx % 3]);
    }
    xs[i] = x; Ps[i] = P;
  }
  let xn = xs[last], Pn = Ps[last];
  out[last] = { p: xn[0], v: xn[1], a: xn[2] };
  for (let i = last - 1; i >= first; i--) {
    const C = mul(mul(Ps[i], tr(Fs[i + 1])), inv(Pp[i + 1]));
    const dx = mv(C, [xn[0] - xp[i + 1][0], xn[1] - xp[i + 1][1], xn[2] - xp[i + 1][2]]);
    const dP = add(Pn, Pp[i + 1].map(v => -v));
    xn = [xs[i][0] + dx[0], xs[i][1] + dx[1], xs[i][2] + dx[2]];
    Pn = add(Ps[i], mul(mul(C, dP), tr(C)));
    out[i] = { p: xn[0], v: xn[1], a: xn[2] };
  }
  return out;
}

/* Smooths a list of { x, y } points (null = untracked). time(i) gives frame i's time in s, rVar(i) the
   measurement variance in px² (Infinity = predicted, not measured). Returns { x, y, vx, vy, ax, ay } or null. */
export function smoothXY(pts, time, rVar, q) {
  // Array.from, not map: untracked frames can be holes in the array, and map skips holes
  const at = f => Array.from(pts, (p, i) => f(p, i));
  const t = at((_, i) => time(i)), r = at((p, i) => p ? rVar(i) : Infinity);
  const X = rts(t, at(p => p ? p.x : null), r, q), Y = rts(t, at(p => p ? p.y : null), r, q);
  return at((_, i) => X[i] && Y[i] ? { x: X[i].p, y: Y[i].p, vx: X[i].v, vy: Y[i].v, ax: X[i].a, ay: Y[i].a } : null);
}
