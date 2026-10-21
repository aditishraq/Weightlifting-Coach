import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../js/state.js';
import { analyse, barPhases, pathPoints } from '../js/path.js';
import { cjHeight, height, load, makeLift, X0, Y0 } from './lift.js';

test('phases of a snatch', () => {
  load(makeLift());
  const ph = barPhases(pathPoints());
  assert.equal(ph.liftoff, 6);
  assert.equal(ph.peak, 40);
  assert.equal(ph.catchIdx, 50);
  assert.equal(ph.jerk, null);
  assert.ok(Math.abs(ph.h(40) - 100) < 1e-9);
});

test('analyse readout', () => {
  // horizontal distances are from the bar's place at lift-off (f6)
  load(makeLift({ barX: i => (i <= 6 ? 0 : i <= 20 ? -3 * (i - 6) / 14 : i <= 40 ? -3 + (i - 20) * 0.3 : 3) }));
  const a = analyse(pathPoints());
  assert.equal(a.peak, 40);
  assert.ok(Math.abs(a.height - 100) < 1e-9);
  assert.ok(Math.abs(a.drop - 15) < 1e-9);
  assert.ok(Math.abs(a.toward - 3) < 1e-9);
  assert.ok(Math.abs(a.away - 3) < 1e-9);       // f40: -3 + 20 * 0.3
  assert.ok(Math.abs(a.range - 6) < 1e-9);
});

test('readout is mirror-symmetric with facing', () => {
  const o = { barX: i => Math.sin(i / 6) * 4 };
  load(makeLift(o)); const r = analyse(pathPoints());
  load(makeLift({ ...o, facing: -1 })); const l = analyse(pathPoints());
  for (const k of ['toward', 'away', 'range', 'height', 'drop', 'catchD']) assert.ok(Math.abs(r[k] - l[k]) < 1e-9, k);
});

test('clean & jerk: finds the dip and the lockout', () => {
  load(makeLift({ n: 91, height: cjHeight }), { lift: 'cj' });
  const ph = barPhases(pathPoints());
  assert.equal(ph.peak, 40);
  assert.equal(ph.catchIdx, 50);
  assert.deepEqual(ph.jerk, { dipStart: 63, dipBottom: 66, top: 74 });
});

test('no jerk when the lift type is not cj', () => {
  load(makeLift({ n: 91, height: cjHeight }));
  assert.equal(barPhases(pathPoints()).jerk, null);
});

test('no lift-off on a bar that never moves', () => {
  load(makeLift({ height: () => 0.5 }));
  assert.equal(barPhases(pathPoints()).liftoff, null);
});

test('fewer than two points gives no phases', () => {
  S.points = [{ x: X0, y: Y0 }];
  assert.equal(barPhases(pathPoints()), null);
});

test('smoothed path keeps gaps and gives velocity in px/s', () => {
  S.smooth = true;
  S.points = Array.from({ length: 30 }, (_, i) => ({ x: 100, y: 500 - 3 * i }));   // 90 px/s upward at 30 fps
  S.points[12] = null;
  const p = pathPoints();
  assert.equal(p[12], null);
  assert.ok(Math.abs(p[20].vy + 90) < 1e-3 && Math.abs(p[20].y - 440) < 1e-3);
  S.smooth = false;
});

// Smooth pull: 100 cm with a cosine profile from f5 to f40 (peak 50π/35 cm/frame at f22.5), then the snatch catch.
const smoothPull = i => i < 5 ? 0 : i <= 40 ? 50 * (1 - Math.cos(Math.PI * (i - 5) / 35)) : i <= 50 ? 100 - 1.5 * (i - 40) : 85;
const V_PEAK = 50 * Math.PI / 35 * 30 / 100;   // m/s at 30 fps

test('peak velocity, pull and turnover times, power', () => {
  load(makeLift({ height: smoothPull })); S.kg = 100;
  const pts = pathPoints(), a = analyse(pts), lo = barPhases(pts).liftoff;
  assert.equal(lo, 8);   // first frame more than 1.5 cm up
  assert.ok(Math.abs(a.vMax / V_PEAK - 1) < 0.01, String(a.vMax));
  assert.ok(Math.abs(a.vIdx - 22.5) <= 0.5, String(a.vIdx));
  assert.ok(Math.abs(a.pullTime - (a.vIdx - lo) / 30) < 1e-9);
  assert.ok(Math.abs(a.pullTime + a.turnoverTime - (50 - lo) / 30) < 1e-9);
  // mean power over the pull = work / time = m (g Δh + Δv² / 2) / t
  const dh = (a.vHeight - smoothPull(lo)) / 100, want = 100 * (9.81 * dh + a.vMax ** 2 / 2) / a.pullTime;
  assert.ok(Math.abs(a.meanPower / want - 1) < 0.05, `${a.meanPower} vs ${want}`);
  assert.ok(a.peakPower > a.meanPower);
  S.kg = null;
  assert.equal(analyse(pathPoints()).peakPower, null);
});

test('frame times override the frame rate', () => {
  load(makeLift({ height: smoothPull }));
  S.times = S.points.map((_, i) => i / 60);   // the same frames, twice as fast
  const a = analyse(pathPoints());
  assert.ok(Math.abs(a.vMax / (2 * V_PEAK) - 1) < 0.01, String(a.vMax));
  S.times = [];
});

test('squat catch: received at the brake, caught where the bar stops, not at the bottom of a slow sink', () => {
  // smooth pull to 100 cm at f40; falls 18 cm to f50 (1.1 m/s); brakes to 0.6 m/s; rides down 12 cm to a stop at f62; sinks 3 cm over 30 frames
  const hgt = i => {
    if (i < 5) return 0;
    if (i <= 40) return 50 * (1 - Math.cos(Math.PI * (i - 5) / 35));
    if (i <= 50) { const u = (i - 40) / 10; return 100 - 18 * u * u; }
    if (i <= 62) { const u = (i - 50) / 12; return 82 - 12 * (2 * u - u * u); }
    return 70 - 3 * Math.min(1, (i - 62) / 30);
  };
  load(makeLift({ n: 100, height: hgt }), { lift: 'clean' });
  const pts = pathPoints(), ph = barPhases(pts), a = analyse(pts);
  assert.ok(Math.abs(ph.receive - 50) <= 2, `receive ${ph.receive}`);
  assert.ok(ph.catchIdx >= 58 && ph.catchIdx <= 64, `catch ${ph.catchIdx}`);
  assert.ok(Math.abs(a.drop * 1 - (100 - hgt(ph.receive))) < 1.5, `drop ${a.drop}`);   // 1 px = 1 cm here
  assert.ok(a.rideDown > 9 && a.rideDown < 14, `ride ${a.rideDown}`);
});

test('the lift window leaves out the set-up and the drop', () => {
  // snatch, stand up to 110 cm by f70, hold to f80, drop the bar to the floor by f88
  const rec = i => i <= 50 ? null : i <= 70 ? 85 + (i - 50) / 20 * 25 : i <= 80 ? 110 : Math.max(0, 110 - (i - 80) / 8 * 110);
  const hgt = i => i <= 50 ? height(i) : rec(i);
  load(makeLift({ n: 95, height: hgt }));
  const a = analyse(pathPoints());
  assert.equal(a.begin, 5);                        // last frame on the floor before lift-off
  assert.ok(Math.abs(a.end - 80) <= 1, `end ${a.end}`);
  assert.equal(a.catchIdx, 50);
  // tracking that stops before the drop keeps everything
  load(makeLift({ n: 75, height: hgt }));
  assert.equal(analyse(pathPoints()).end, 74);
  // clean & jerk: ends after the jerk's hold
  load(makeLift({ n: 110, height: i => i <= 90 ? cjHeight(i) : Math.max(0, 160 - (i - 90) * 20) }), { lift: 'cj' });
  const c = analyse(pathPoints());
  assert.ok(c.jerk && Math.abs(c.end - 90) <= 1, `cj end ${c.end}`);
});
