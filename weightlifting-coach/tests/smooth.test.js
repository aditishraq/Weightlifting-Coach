import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rts, smoothXY } from '../js/smooth.js';

const rand = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(42);
const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());

test('recovers a constant-acceleration path exactly, with uneven time steps', () => {
  const t = []; let s = 0;
  for (let i = 0; i < 60; i++) { t.push(s); s += i % 3 ? 1 / 30 : 1 / 60; }
  const z = t.map(x => 3 + 2 * x + 4.5 * x * x);
  const out = rts(t, z, 1e-4, 10);
  for (const i of [5, 30, 55]) {
    assert.ok(Math.abs(out[i].p - z[i]) < 1e-3);
    assert.ok(Math.abs(out[i].v - (2 + 9 * t[i])) < 0.02, `v ${out[i].v}`);
    assert.ok(Math.abs(out[i].a - 9) < 0.2, `a ${out[i].a}`);
  }
});

test('bridges missing frames and reduces noise', () => {
  const n = 200, t = Array.from({ length: n }, (_, i) => i / 60);
  const truth = t.map(x => Math.sin(2 * x)), z = truth.map(v => v + 0.01 * gauss());
  z[100] = null;
  const r = z.map((_, i) => i === 50 ? Infinity : 1e-4);
  const out = rts(t, z, r, 50);
  let se = 0, sz = 0;
  for (let i = 0; i < n; i++) { se += (out[i].p - truth[i]) ** 2; if (z[i] != null && i !== 50) sz += (z[i] - truth[i]) ** 2; }
  assert.ok(Math.sqrt(se / n) < 0.6 * Math.sqrt(sz / (n - 2)));
  assert.ok(Math.abs(out[100].p - truth[100]) < 0.01 && Math.abs(out[50].p - truth[50]) < 0.01);
});

test('nothing outside the measured range', () => {
  const out = rts([0, 1, 2, 3], [null, 1, 2, null], 1, 1);
  assert.equal(out[0], null); assert.equal(out[3], null); assert.ok(out[1] && out[2]);
});

test('untracked frames may be holes in the array', () => {
  const pts = [];
  for (const i of [0, 1, 2, 6, 7, 8]) pts[i] = { x: i, y: 2 * i };   // 3..5 are holes, not nulls
  const out = smoothXY(pts, i => i / 30, () => 1e-4, 10);
  assert.ok(Math.abs(out[7].x - 7) < 1e-3 && Math.abs(out[7].vx - 30) < 0.1);
  assert.ok(Number.isFinite(out[4].x));
});
