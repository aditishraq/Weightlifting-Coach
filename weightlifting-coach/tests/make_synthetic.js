/* Synthetic lift videos with exact ground truth. Needs only Node and ffmpeg on PATH.
     node tests/make_synthetic.js              all presets
     node tests/make_synthetic.js snatch60     one preset
   Writes samples/<name>.mp4 and samples/<name>.truth.json.

   Side-on camera, lifter facing right (+x = away from the lifter), 450 mm plate. The bar and joints follow
   monotone cubic (PCHIP) splines through keyframes, so positions and velocities are known exactly and the
   peaks sit on the keyframes. Each frame averages sub-frames over the shutter (motion blur), then adds
   sensor noise, light flicker and camera shake, then goes through H.264. */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 720, H = 1280, PX_PER_M = 500, FLOOR_Y = 1200, X0 = 400;
const PLATE_R = 0.225 * PX_PER_M, BAR_Y0 = FLOOR_Y - PLATE_R;

const PRESETS = {
  snatch60:     { lift: 'snatch', fps: 60, noise: 2.5, shutter: 0.5, ratio: 1.00, flicker: 0,    shake: 0,   crf: 18, face: [198, 40, 36] },
  snatch30hard: { lift: 'snatch', fps: 30, noise: 7,   shutter: 0.9, ratio: 0.90, flicker: 0.06, shake: 0.6, crf: 28, face: [40, 98, 200] },
  // someone walks between the camera and the bar during the first pull
  snatch30occl: { lift: 'snatch', fps: 30, noise: 4,   shutter: 0.6, ratio: 1.00, flicker: 0,    shake: 0.3, crf: 23, face: [198, 40, 36], occlude: [0.75, 1.35] },
  // a gym: spare plates on the floor behind the lifter and hanging on the wall
  snatch30gym:  { lift: 'snatch', fps: 30, noise: 4,   shutter: 0.6, ratio: 1.00, flicker: 0,    shake: 0.3, crf: 23, face: [40, 98, 200],
                  extras: [{ x: 600, y: 1200 - 95, r: 95, face: [236, 190, 48], rot: 0.4 }, { x: 140, y: 330, r: 88, face: [198, 40, 36], rot: 1.9 }, { x: 640, y: 560, r: 60, face: [47, 180, 87], rot: 0.9 }] },
  cj30:         { lift: 'cj',     fps: 30, noise: 4,   shutter: 0.6, ratio: 0.97, flicker: 0.02, shake: 0.3, crf: 23, face: [236, 190, 48] },
};

/* ---------- Trajectories ---------- */
// Columns: t (s), label, bar x and bar rise (m), then knee, hip, shoulder as [x, height above floor] (m, x relative to the bar start).
const LIFTS = {
  snatch: [
    [0.00, '',        0,      0,    [0.10, 0.45], [-0.25, 0.68], [0.03, 1.05]],
    [0.50, '',        0,      0,    [0.10, 0.45], [-0.25, 0.68], [0.03, 1.05]],
    [0.60, 'liftoff', 0,      0.01, [0.10, 0.45], [-0.24, 0.69], [0.03, 1.06]],
    [1.00, 'knee',   -0.030,  0.30, [-0.02, 0.50], [-0.22, 0.85], [0.02, 1.25]],
    [1.25, '',       -0.015,  0.48, [0.05, 0.48], [-0.12, 0.92], [-0.02, 1.38]],
    [1.40, '',        0.025,  0.72, [0.00, 0.52], [-0.08, 1.00], [-0.10, 1.46]],
    [1.52, '',        0.020,  0.92, [0.05, 0.50], [-0.12, 0.93], [-0.10, 1.40]],
    [1.64, 'peak',    0.000,  1.00, [0.15, 0.46], [-0.20, 0.72], [-0.10, 1.20]],
    [1.80, 'catch',  -0.040,  0.80, [0.25, 0.42], [-0.30, 0.48], [-0.12, 0.95]],
    [2.40, '',       -0.040,  0.80, [0.25, 0.42], [-0.30, 0.48], [-0.12, 0.95]],
    [3.40, '',       -0.030,  1.83, [-0.02, 0.50], [-0.07, 0.98], [-0.07, 1.45]],
    [3.90, '',       -0.030,  1.83, [-0.02, 0.50], [-0.07, 0.98], [-0.07, 1.45]],
  ],
  cj: [
    [0.00, '',         0,      0,    [0.10, 0.45], [-0.25, 0.68], [0.03, 1.05]],
    [0.50, '',         0,      0,    [0.10, 0.45], [-0.25, 0.68], [0.03, 1.05]],
    [0.60, 'liftoff',  0,      0.01, [0.10, 0.45], [-0.24, 0.69], [0.03, 1.06]],
    [1.00, 'knee',    -0.030,  0.30, [-0.02, 0.50], [-0.22, 0.85], [0.02, 1.25]],
    [1.25, '',        -0.015,  0.48, [0.05, 0.48], [-0.12, 0.92], [-0.02, 1.38]],
    [1.40, '',         0.020,  0.68, [0.00, 0.52], [-0.08, 1.00], [-0.10, 1.46]],
    [1.55, 'peak',     0.010,  0.86, [0.10, 0.48], [-0.15, 0.85], [-0.06, 1.32]],
    [1.72, 'catch',   -0.020,  0.72, [0.25, 0.42], [-0.28, 0.48], [-0.05, 0.95]],
    [2.20, '',        -0.020,  0.72, [0.25, 0.42], [-0.28, 0.48], [-0.05, 0.95]],
    [3.20, '',        -0.015,  1.22, [-0.02, 0.50], [-0.07, 0.98], [-0.03, 1.45]],
    [4.00, 'dipStart',-0.015,  1.22, [-0.02, 0.50], [-0.07, 0.98], [-0.03, 1.45]],
    [4.25, 'dipBottom',-0.010, 1.10, [0.06, 0.47], [-0.09, 0.86], [-0.03, 1.33]],
    [4.42, '',         0.000,  1.45, [-0.02, 0.50], [-0.07, 0.98], [-0.03, 1.45]],
    [4.70, 'lockout', -0.020,  1.70, [0.20, 0.40], [-0.10, 0.80], [-0.05, 1.27]],
    [5.60, '',        -0.020,  1.70, [0.20, 0.40], [-0.10, 0.80], [-0.05, 1.27]],
  ],
};

function pchip(ts, ys) {
  const n = ts.length, d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (ts[i + 1] - ts[i]);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i], w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (t, deriv = false) => {
    t = Math.min(ts[n - 1], Math.max(0, t));
    let k = 0; while (k < n - 2 && t > ts[k + 1]) k++;
    const h = ts[k + 1] - ts[k], u = (t - ts[k]) / h, y0 = ys[k], y1 = ys[k + 1], a = h * m[k], b = h * m[k + 1];
    if (deriv) return ((6 * u * u - 6 * u) * y0 + (3 * u * u - 4 * u + 1) * a + (6 * u - 6 * u * u) * y1 + (3 * u * u - 2 * u) * b) / h;
    return (2 * u ** 3 - 3 * u * u + 1) * y0 + (u ** 3 - 2 * u * u + u) * a + (3 * u * u - 2 * u ** 3) * y1 + (u ** 3 - u * u) * b;
  };
}

function motion(keys) {
  const ts = keys.map(k => k[0]), col = f => pchip(ts, keys.map(f));
  const bx = col(k => k[2]), bh = col(k => k[3]);
  const joint = j => ({ x: col(k => k[j][0]), y: col(k => k[j][1]) });
  return { dur: ts[ts.length - 1], bx, bh, knee: joint(4), hip: joint(5), sh: joint(6),
           label: Object.fromEntries(keys.filter(k => k[1]).map(k => [k[1], k[0]])) };
}

/* ---------- Rendering (float RGB, coverage anti-aliasing) ---------- */
const rng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cov = d => Math.min(1, Math.max(0, 0.5 - d));   // signed distance (px, negative inside) → coverage

function background() {
  const bg = new Float32Array(W * H * 3), r = rng(7);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    let c;
    if (y < FLOOR_Y) {
      const g = 52 - 22 * y / FLOOR_Y, post = (x > 60 && x < 92) || (x > 640 && x < 672);
      const hole = post && (x % 16 > 6 && x % 16 < 12) && (y % 48 < 10);
      c = post ? (hole ? [30, 32, 35] : [70, 76, 84]) : [g + 4, g + 6, g + 9];
    } else {
      const plank = Math.floor(x / 140) % 2, grain = 6 * Math.sin(x * 0.11 + Math.sin(y * 0.05) * 3);
      c = [140 + grain - plank * 12, 106 + grain - plank * 10, 70 + grain - plank * 6];
      if (x % 140 < 2) c = [100, 75, 50];
    }
    const n = (r() - 0.5) * 6;
    bg[o] = c[0] + n; bg[o + 1] = c[1] + n; bg[o + 2] = c[2] + n;
  }
  return bg;
}

function blend(buf, x, y, a, c) {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  buf[o] += (c[0] - buf[o]) * a; buf[o + 1] += (c[1] - buf[o + 1]) * a; buf[o + 2] += (c[2] - buf[o + 2]) * a;
}

function capsule(buf, ax, ay, bx, by, rad, c) {
  const x0 = Math.floor(Math.min(ax, bx) - rad - 1), x1 = Math.ceil(Math.max(ax, bx) + rad + 1);
  const y0 = Math.floor(Math.min(ay, by) - rad - 1), y1 = Math.ceil(Math.max(ay, by) + rad + 1);
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const u = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(x - ax - u * dx, y - ay - u * dy) - rad;
    const shade = 1 - 0.25 * Math.max(0, Math.min(1, (d + rad) / rad));   // darker toward the silhouette edge
    blend(buf, x, y, cov(d), [c[0] * shade, c[1] * shade, c[2] * shade]);
  }
}

function plate(buf, cx, cy, theta, ratio, face, R = PLATE_R) {
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const hub = [182, 186, 190], rim = [24, 24, 26], white = [240, 238, 232];
  for (let y = Math.floor(cy - R - 2); y <= Math.ceil(cy + R + 2); y++)
    for (let x = Math.floor(cx - R * ratio - 2); x <= Math.ceil(cx + R * ratio + 2); x++) {
      const u = (x - cx) / ratio, v = y - cy, r = Math.hypot(u, v);
      const a = cov((r - R) * Math.min(1, ratio));
      if (a <= 0) continue;
      // layers from outside in, each softened over one pixel
      let c = rim;
      const mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
      c = mix(c, face, cov(r - 0.93 * R));
      const ring = Math.abs(r - 0.62 * R) - 2.5; c = mix(c, face.map(q => q * 0.7), cov(ring));
      // rotating white markings: two text bars and a logo dot
      const pu = u * cs + v * sn, pv = -u * sn + v * cs;
      const bar = Math.max(Math.abs(pu) - 0.20 * R, Math.abs(Math.abs(pv) - 0.45 * R) - 0.06 * R);
      c = mix(c, white, cov(bar));
      c = mix(c, white, cov(Math.hypot(pu - 0.75 * R, pv) - 0.05 * R));
      c = mix(c, hub.map((q, i) => q - 40 * r / R), cov(r - 0.30 * R));
      c = mix(c, [130, 136, 142], cov(r - 0.14 * R));
      c = mix(c, [60, 64, 68], cov(r - 0.06 * R));
      blend(buf, x, y, a, c);
    }
}

function drawScene(buf, m, t, P, sx, sy) {
  const X = xm => X0 + sx + xm * PX_PER_M, Y = hm => FLOOR_Y + sy - hm * PX_PER_M;
  for (const e of P.extras || []) plate(buf, e.x + sx, e.y + sy, e.rot, 1, e.face, e.r);   // behind the lifter
  const kit = [34, 40, 58], skin = [150, 110, 90];
  const ank = [X(-0.03), Y(0.08)], kn = [X(m.knee.x(t)), Y(m.knee.y(t))], hp = [X(m.hip.x(t)), Y(m.hip.y(t))], sh = [X(m.sh.x(t)), Y(m.sh.y(t))];
  const bar = [X(m.bx(t)), BAR_Y0 + sy - m.bh(t) * PX_PER_M];
  capsule(buf, ank[0] - 30, ank[1] + 30, ank[0] + 70, ank[1] + 30, 14, [20, 20, 22]);   // shoe
  capsule(buf, ...ank, ...kn, 28, kit);
  capsule(buf, ...kn, ...hp, 40, kit);
  capsule(buf, ...hp, ...sh, 58, kit);
  capsule(buf, ...sh, ...bar, 22, skin);
  capsule(buf, sh[0] + 25, sh[1] - 60, sh[0] + 30, sh[1] - 95, 50, skin);   // head
  plate(buf, ...bar, 1.4 * m.bh(t) + 0.15 * Math.sin(3 * t), P.ratio, P.face);
  if (P.occlude && t >= P.occlude[0] && t <= P.occlude[1]) {   // a passer-by close to the camera: wide, dark, out of focus
    const u = (t - P.occlude[0]) / (P.occlude[1] - P.occlude[0]), ox = -250 + u * (W + 500);
    capsule(buf, ox, 300, ox, H + 200, 170, [52, 54, 58]);
  }
}

/* ---------- Video + truth ---------- */
async function make(name) {
  const P = PRESETS[name], m = motion(LIFTS[P.lift]), N = Math.round(m.dur * P.fps) + 1, SUB = 6;
  mkdirSync('samples', { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(P.fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(P.crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `samples/${name}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => c ? rej(new Error(`ffmpeg exited ${c}`)) : res()));
  const bg = background(), buf = new Float32Array(bg.length), acc = new Float32Array(bg.length), out = Buffer.alloc(W * H * 3);
  const r = rng(99), shakeR = rng(5), frames = [];
  for (let i = 0; i < N; i++) {
    const t = i / P.fps, sx = (shakeR() - 0.5) * 2 * P.shake, sy = (shakeR() - 0.5) * 2 * P.shake;
    acc.fill(0);
    for (let s = 0; s < SUB; s++) {
      buf.set(bg);
      drawScene(buf, m, t + ((s + 0.5) / SUB - 0.5) * P.shutter / P.fps, P, sx, sy);
      for (let k = 0; k < acc.length; k++) acc[k] += buf[k];
    }
    const gain = 1 + P.flicker * Math.sin(2 * Math.PI * 10 * t);   // mains flicker aliased to 10 Hz
    for (let k = 0; k < acc.length; k += 3) {
      const n = (r() + r() + r() - 1.5) * 2 * P.noise;               // ≈ Gaussian, sd ≈ P.noise
      for (let c = 0; c < 3; c++) out[k + c] = Math.max(0, Math.min(255, acc[k + c] / SUB * gain + n));
    }
    if (!ff.stdin.write(out)) await new Promise(res => ff.stdin.once('drain', res));
    const J = j => [+(X0 + sx + j.x(t) * PX_PER_M).toFixed(2), +(FLOOR_Y + sy - j.y(t) * PX_PER_M).toFixed(2)];
    frames.push({
      t: +t.toFixed(5),
      x: +(X0 + sx + m.bx(t) * PX_PER_M).toFixed(3), y: +(BAR_Y0 + sy - m.bh(t) * PX_PER_M).toFixed(3),   // bar centre in px
      xm: +m.bx(t).toFixed(5), hm: +m.bh(t).toFixed(5), vy: +m.bh(t, true).toFixed(4), vx: +m.bx(t, true).toFixed(4),   // m and m/s
      knee: J(m.knee), hip: J(m.hip), shoulder: J(m.sh),
    });
    if (process.stdout.isTTY) process.stdout.write(`\r${name}: ${i + 1}/${N}`);
  }
  ff.stdin.end(); await done;

  // Exact figures from the splines. Peak velocity is searched finely between lift-off and the pull peak.
  const L = m.label, f = s => Math.round(s * P.fps);
  let vmax = 0, tv = 0;
  for (let t = L.liftoff; t <= L.peak; t += 1e-4) { const v = m.bh(t, true); if (v > vmax) { vmax = v; tv = t; } }
  const truth = {
    name, lift: P.lift, fps: P.fps, W, H, frames: N, pxPerM: PX_PER_M, plateRadiusPx: PLATE_R, axisRatio: P.ratio, facing: 1,
    start: { frame: 0, x: X0, y: BAR_Y0 },
    conditions: { noise: P.noise, shutter: P.shutter, flicker: P.flicker, shakePx: P.shake, crf: P.crf, occlude: P.occlude || null },
    // lift-off uses the app's rule (bar more than 1.5 cm up); the others are the keyframe times
    keyFrames: { ...Object.fromEntries(Object.entries(L).map(([k, s]) => [k, f(s)])), liftoff: frames.findIndex(q => q.hm > 0.015) },
    metrics: {
      pullHeightCm: +(m.bh(L.peak) * 100).toFixed(2),
      dropCm: +((m.bh(L.peak) - m.bh(L.catch)) * 100).toFixed(2),
      peakVelocity: { ms: +vmax.toFixed(4), t: +tv.toFixed(4), frame: +(tv * P.fps).toFixed(2) },
      ...(L.lockout ? { jerkDipCm: +((m.bh(L.dipStart) - m.bh(L.dipBottom)) * 100).toFixed(2) } : {}),
    },
    perFrame: frames,
  };
  writeFileSync(`samples/${name}.truth.json`, JSON.stringify(truth));
  console.log(`\r${name}: ${N} frames → samples/${name}.mp4`);
}

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PRESETS)) await make(name);
