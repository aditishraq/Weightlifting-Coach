import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlate, fitPlateEdges, platePrior, scorePlate } from '../js/plate.js';
import { plateImage } from './images.js';

const asRoi = img => ({ ...img, x0: 0, y0: 0 });
// crop(cx, cy, half) for a full-resolution test image
const cropper = img => (cx, cy, half) => {
  const x0 = Math.max(0, Math.floor(cx - half)), y0 = Math.max(0, Math.floor(cy - half));
  const w = Math.min(img.w, Math.ceil(cx + half) + 1) - x0, h = Math.min(img.h, Math.ceil(cy + half) + 1) - y0, g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = img.g[(y0 + y) * img.w + x0 + x];
  return { g, w, h, x0, y0 };
};
// box-filter shrink by an integer factor, as the browser does for the work image
const shrink = (img, f) => {
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f), g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += img.g[(y * f + j) * img.w + x * f + i];
    g[y * w + x] = s / (f * f);
  }
  return { g, w, h, sx: w / img.w, sy: h / img.h };
};

test('edge fit finds the outer rim to sub-pixel accuracy', () => {
  const img = plateImage(320, 300, 150.4, 140.7, 100, 0.4, 4);
  // start from a guess on the face ring inside the rim, off-centre
  const f = fitPlateEdges(asRoi(img), 147, 143, 90);
  assert.ok(Math.hypot(f.x - 150.4, f.y - 140.7) < 0.2, JSON.stringify(f));
  assert.ok(Math.abs(f.r - 100) < 0.4, `r ${f.r}`);
  assert.ok(f.ratio > 0.99 && f.support > 0.9);
});

test('edge fit measures a squeezed plate: radius from the long axis, ratio from both', () => {
  const img = plateImage(320, 300, 160, 150, 100, 0, 3, 60, 0.88);
  const f = fitPlateEdges(asRoi(img), 158, 152, 95);
  assert.ok(Math.abs(f.ratio - 0.88) < 0.01, `ratio ${f.ratio}`);
  assert.ok(Math.abs(f.r - 100) < 0.5 && Math.abs(f.b - 100) < 0.5, JSON.stringify(f));
});

test('no fit on a blank crop', () => {
  assert.equal(fitPlateEdges(asRoi({ g: new Float32Array(200 * 200).fill(60), w: 200, h: 200 }), 100, 100, 60), null);
});

test('detection with a body prior picks the lifter\'s plate over a background plate', () => {
  // the lifter's plate on the floor, a smaller one higher up in the background
  let img = plateImage(640, 480, 420, 380, 90, 0.2, 3);
  img = plateImage(640, 480, 140, 150, 55, 1.1, 0, 60, 1, img);
  const prior = { expectedR: 85, floorY: 470, wrist: { x: 425, y: 372 }, box: { x0: 250, y0: 220, x1: 600, y1: 480 } };
  const [best] = detectPlate(shrink(img, 2), cropper(img), 640, 480, prior);
  assert.ok(Math.hypot(best.x - 420, best.y - 380) < 0.5 && Math.abs(best.r - 90) < 0.6, JSON.stringify(best));
  assert.ok(best.score > 0.8, String(best.score));
});

test('detection without a prior still finds a lone plate', () => {
  const img = plateImage(640, 480, 300, 330, 80, 0.7, 4);
  const [best] = detectPlate(shrink(img, 2), cropper(img), 640, 480);
  assert.ok(Math.hypot(best.x - 300, best.y - 330) < 0.5 && Math.abs(best.r - 80) < 0.6, JSON.stringify(best));
});

test('score prefers the expected size, the floor and the wrist', () => {
  const fit = { x: 100, y: 100, r: 50, a: 50, b: 50, support: 0.9 };
  const prior = { expectedR: 50, floorY: 150, wrist: { x: 100, y: 100 } };
  const good = scorePlate(fit, prior).score;
  assert.ok(good > 0.95);
  assert.ok(scorePlate({ ...fit, r: 70, a: 70, b: 70 }, prior).score < good - 0.2);
  assert.ok(scorePlate({ ...fit, y: 60 }, prior).score < good - 0.2);
});

test('pose prior: plate size from the legs and torso, floor from the feet', () => {
  const L = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
  const put = (i, x, y, v = 0.9) => { L[i] = { x, y, v }; };
  // 1.75 m lifter at 400 px/m: shin 0.43 m, thigh 0.43 m, torso 0.50 m (sum 1.36 m ≈ 0.779 × 1.75)
  put(27, 300, 900); put(25, 300 + 0.43 * 400, 900); put(23, 300 + 0.43 * 400, 900 - 0.43 * 400); put(11, 300 + 0.43 * 400, 900 - 0.93 * 400);
  for (const i of [28, 26, 24, 12]) put(i, 0, 0, 0.1);
  put(29, 280, 930); put(31, 340, 935); put(15, 330, 820);
  const p = platePrior(L);
  assert.ok(Math.abs(p.height / 400 - 1.746) < 0.01, String(p.height));
  assert.ok(Math.abs(p.expectedR / 400 - 0.227) < 0.002, String(p.expectedR));
  assert.equal(p.floorY, 935);
  assert.deepEqual(p.wrist, { x: 330, y: 820 });
  assert.ok(p.box.x0 < 310 && p.box.x1 > 330 && p.box.y1 >= 935);
});
