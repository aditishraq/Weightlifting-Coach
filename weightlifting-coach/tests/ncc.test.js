import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarTracker, cutPatch, match, prepTpl, radialCenter } from '../js/ncc.js';
import { houghCircles } from '../js/circles.js';
import { CONFIG } from '../js/config.js';

import { plateImage, rand } from './images.js';

test('SAT matching gives the same scores as brute force', () => {
  const img = { g: Float32Array.from({ length: 80 * 60 }, () => rand() * 255), w: 80, h: 60 };
  const other = { ...img, g: img.g.map(v => v + 40 * (rand() - 0.5)) };   // template from a noisier copy
  const ts = 15, tpl = prepTpl(cutPatch(other, 40, 30, ts));
  const m = match(img, tpl, ts, 37, 28, 6), bx = Math.round(m.x), by = Math.round(m.y);
  assert.deepEqual([bx, by], [40, 30]);
  // naive NCC at the best integer position
  const p = cutPatch(img, bx, by, ts), mean = p.reduce((a, v) => a + v, 0) / p.length;
  let c = 0, v2 = 0;
  for (let k = 0; k < p.length; k++) { c += (p[k] - mean) * tpl.t[k]; v2 += (p[k] - mean) ** 2; }
  assert.ok(Math.abs(m.score - c / Math.sqrt(v2 * tpl.n2)) < 1e-4);
});

test('match is sub-pixel and the template is cut at the exact mark', () => {
  const a = plateImage(120, 120, 60.3, 59.6, 28), b = plateImage(120, 120, 63.1, 57.2, 28);
  const ts = 41, tpl = prepTpl(cutPatch(a, 60.3, 59.6, ts));
  const m = match(b, tpl, ts, 60, 60, 8);
  assert.ok(Math.hypot(m.x - 63.1, m.y - 57.2) < 0.1, JSON.stringify(m));
});

test('radial centre is unbiased by rotation and noise', () => {
  for (const theta of [0, 0.7, 2.4]) {
    const img = plateImage(300, 300, 151.37, 148.81, 110, theta, 6);
    const c = radialCenter({ ...img, x0: 0, y0: 0 }, 147, 152, 110);
    assert.ok(Math.hypot(c.x - 151.37, c.y - 148.81) < 0.15, `θ=${theta}: ${JSON.stringify(c)}`);
  }
});

test('Hough finds the plate centre', () => {
  const img = plateImage(160, 160, 90, 70, 28, 0.3, 4);
  const [c] = houghCircles(img, { x0: 40, y0: 30, x1: 140, y1: 120 }, 22, 32, 3);
  // any of the concentric edges (rim, face, ring) may win; the centre is what re-finding needs
  assert.ok(Math.hypot(c.x - 90, c.y - 70) <= 1.5 && c.r >= 22 && c.r <= 30, JSON.stringify(c));
});

test('tracker follows a moving, rotating plate', () => {
  const tk = new BarTracker({ ...CONFIG.tracking, fps: 30 }), R = 28, ts = 41;
  const at = i => ({ x: 100 + 0.4 * i, y: 200 - 0.08 * i * i });
  assert.equal(tk.init(plateImage(200, 260, at(0).x, at(0).y, R), at(0).x, at(0).y, ts, R), null);
  for (let i = 1; i < 30; i++) {
    const p = at(i), r = tk.step(plateImage(200, 260, p.x, p.y, R, 0.05 * i, 3));
    assert.ok(!r.low && !r.lost, `frame ${i}`);
    const f = tk.finish(null);
    assert.ok(Math.hypot(f.x - p.x, f.y - p.y) < 0.6, `frame ${i}: ${JSON.stringify(f)} vs ${JSON.stringify(p)}`);
  }
});

test('tracker re-finds the plate after it disappears and comes back elsewhere', () => {
  const tk = new BarTracker({ ...CONFIG.tracking, fps: 30 }), R = 28, ts = 41, W = 360, H = 260;
  tk.init(plateImage(W, H, 100, 130, R), 100, 130, ts, R);
  for (let i = 1; i <= 3; i++) { tk.step(plateImage(W, H, 100, 130, R)); tk.finish(null); }
  const blank = { g: new Float32Array(W * H).fill(60), w: W, h: H, sx: 1, sy: 1 };
  for (let i = 0; i < 4; i++) assert.ok(tk.step(blank).low);
  // back 75 px away: outside the matching window, inside the circle search
  const r = tk.step(plateImage(W, H, 175, 130, R));
  assert.ok(r.refound && Math.hypot(r.x - 175, r.y - 130) < 1, JSON.stringify(r));
});

test('tracker gives up after the re-find window', () => {
  const cfg = { ...CONFIG.tracking, fps: 30 }, tk = new BarTracker(cfg), W = 200, H = 200;
  tk.init(plateImage(W, H, 100, 100, 28), 100, 100, 41, 28);
  const blank = { g: new Float32Array(W * H).fill(60), w: W, h: H, sx: 1, sy: 1 };
  let n = 0, r;
  do { r = tk.step(blank); n++; } while (!r.lost && n < 100);
  assert.equal(n, cfg.lostFrames + Math.round(cfg.refindSeconds * 30));
});
