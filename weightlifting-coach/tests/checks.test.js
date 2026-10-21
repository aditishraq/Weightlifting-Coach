import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../js/checks.js';
import { finishPose } from '../js/pose.js';
import { S } from '../js/state.js';
import { cjHeight, load, makeLift } from './lift.js';

const run = (o, opts) => { load(makeLift(o), opts); return evaluate(); };
const status = r => Object.fromEntries(r.checks.map(c => [c.id, c.status]));
const GOOD = { shoulders: 'good', hips: 'good', close1: 'good', heels: 'good', arms: 'good', extension: 'good', close2: 'good', feet: 'good', catchPos: 'good', turnover: 'info' };

test('a clean lift passes every check', () => {
  const r = run({});
  assert.deepEqual(status(r), GOOD);
  assert.deepEqual(r.keys, { liftoff: 6, knee: 14, ext: 32, peak: 40, catch: 50, jerk: null });
});

test('facing left gives the same verdicts', () => {
  assert.deepEqual(status(run({ facing: -1 })), GOOD);
});

// Each fault changes one thing; the named check must flip and everything listed stays good.
const drift = i => i <= 6 ? 0 : i <= 14 ? (i - 6) / 8 * 5 : Math.max(0, 5 - (i - 14) * 2);   // from lift-off (f6)
const cases = [
  // the test lifter's femur is 49 cm, so faults are judged against that (thresholds are in femur lengths)
  ['shoulders behind the bar', { shoulderX: () => -10 }, { shoulders: 'fault' }],
  // the second-pull window starts at the knee frame, where the bar is still 5 cm out
  ['bar drifts forward off the floor', { barX: drift, shoulderX: drift }, { close1: 'fault', close2: 'watch' }],
  ['hips shoot up', { hipRise: 1.8 }, { hips: 'fault' }],
  ['heels come up early', { heelUp: i => i >= 10 ? 4 : 0 }, { heels: 'watch' }],
  ['arms bend early', { elbowOut: i => i >= 18 && i <= 24 ? 20 : 0 }, { arms: 'fault' }],
  ['hips never open', { shortExt: true }, { extension: 'fault' }],
  ['bar swings out at the hips', { barX: i => i > 14 && i <= 40 ? Math.min(7, (i - 14) * 0.5) : 0 }, { close2: 'fault' }],
  ['feet jump forward', { footShift: 9 }, { feet: 'fault', catchPos: 'fault' }],
  ['feet jump back a lot', { footShift: -10 }, { feet: 'watch', catchPos: 'watch' }],
];
for (const [name, o, want] of cases) test(name, () => {
  assert.deepEqual(status(run(o)), { ...GOOD, ...want });
});

test('without pose, body checks are n/a and bar checks still run', () => {
  const s = status(run({ noPose: true }));
  for (const id of ['shoulders', 'hips', 'heels', 'arms', 'extension', 'feet', 'catchPos']) assert.equal(s[id], 'na', id);
  assert.equal(s.close1, 'good');
  assert.equal(s.close2, 'good');
});

test('a bar that never leaves the floor is an error', () => {
  assert.match(run({ height: () => 0 }).error, /never leaves the floor/);
});

test('every finding points at a frame or is n/a', () => {
  for (const c of run({}).checks) assert.ok(c.frame != null || c.status === 'na', c.id);
});

test('jerk: straight drive passes, forward drive and press-out fail', () => {
  const cj = o => status(run({ n: 91, height: cjHeight, ...o }, { lift: 'cj' }));
  const s = cj({});
  assert.deepEqual([s.dip, s.drive, s.lockout], ['good', 'good', 'good']);
  assert.equal(cj({ barX: i => i > 66 ? (i - 66) * 1.5 : 0 }).drive, 'fault');
  // elbow bent as the bar arrives overhead (f72), straight by f80
  assert.equal(cj({ elbowOut: i => i >= 70 && i < 80 ? 25 : 0 }).lockout, 'fault');
});

test('joints with gaps (holes in the array) still smooth and check', () => {
  const lift = makeLift();
  load(lift);
  S.pose = []; lift.poseS.forEach((L, i) => { if (i % 7 !== 3) S.pose[i] = L.map(p => ({ ...p })); });   // every 7th frame missing
  finishPose();
  assert.ok(S.poseS.every(L => !L || L.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))));
  assert.deepEqual(status(evaluate()), GOOD);
});

const find = (r, id) => r.checks.find(c => c.id === id);

test('every verdict carries a confidence; clean input is fully trusted', () => {
  // the arms check uses the bar for the hand (the plate hides it), which costs a little; at full extension the
  // test lifter's hip is behind the plate, which costs more
  const expect = { arms: 0.85 };
  for (const c of run({}).checks) if (c.id !== 'extension') assert.equal(c.confidence, expect[c.id] ?? 1, c.id);
  assert.ok(find(run({}), 'extension').confidence < 1);
  for (const c of run({ noPose: true }).checks) assert.ok(c.status === 'na' ? c.confidence === null : c.confidence === 1, c.id);
});

test('feet hidden behind the plate at set-up: start position from the first pull, lower confidence', () => {
  // heels and toes (29–32) barely visible until lift-off, as when the near plate covers them
  const r = run({ vis: (i, k) => k >= 29 && k <= 32 && i <= 6 ? 0.35 : 1 });
  const feet = find(r, 'feet'), heels = find(r, 'heels');
  assert.equal(feet.status, 'good'); assert.match(feet.text, /plate hid the feet/);
  assert.equal(heels.status, 'good');
  assert.ok(feet.confidence < 1 && heels.confidence < 1);
});

test('a hidden foot is not a moved foot', () => {
  // the set-up guess sits 10 cm behind the real foot, with low visibility: it must not read as a jump
  const lift = makeLift();
  for (let i = 0; i <= 6; i++) for (const k of [29, 31]) { lift.poseS[i][k].x += 10; lift.poseS[i][k].v = 0.4; }
  load(lift);
  assert.equal(status(evaluate()).feet, 'good');
});

test('a joint behind the plate lowers the confidence', () => {
  const near = find(run({}), 'extension').confidence;   // hip 3 px from the bar centre at extension
  const lift = makeLift();
  for (const L of lift.poseS) L[23].x -= 30;   // move the hip well clear of the plate
  load(lift);
  assert.ok(find(evaluate(), 'extension').confidence > near);
});

test('joints the model barely saw give n/a with a reason, not a verdict', () => {
  const r = run({ vis: () => 0.4 });
  for (const id of ['shoulders', 'hips', 'heels', 'arms', 'extension', 'feet', 'catchPos']) {
    const c = find(r, id);
    assert.equal(c.status, 'na', id); assert.match(c.text, /couldn't see/, id);
  }
});

test('turned camera: bar-vs-body checks are skipped, bar distances are corrected', () => {
  const drift = i => i <= 6 ? 0 : Math.min(1, (i - 6) / 8) * 3;   // 3 cm forward in the picture by the knee
  const side = run({ barX: drift, shoulderX: drift }), turned = run({ barX: drift, shoulderX: drift }, { axisRatio: 0.9 });
  for (const id of ['shoulders', 'catchPos']) { assert.equal(find(turned, id).status, 'na', id); assert.match(find(turned, id).text, /isn't side-on/); }
  const cmIn = c => parseFloat(c.text.match(/drifted ([\d.]+) cm/)[1]);
  assert.ok(Math.abs(cmIn(find(turned, 'close1')) / cmIn(find(side, 'close1')) - 1 / 0.9) < 0.02);   // 3.0 → 3.3 cm
  assert.ok(find(turned, 'close1').confidence < find(side, 'close1').confidence);
});

test('a camera just short of side-on: bar-vs-body verdicts lose confidence fast, no hard switch', () => {
  const conf = r => find(run({}, { axisRatio: r }), 'shoulders').confidence;
  assert.ok(conf(0.97) > conf(0.95) && conf(0.95) > conf(0.93));
  assert.ok(conf(0.95) < 0.5);
  assert.equal(find(run({}, { axisRatio: 0.915 }), 'shoulders').status, 'na');
});

test('a camera far off side-on gives n/a for everything horizontal', () => {
  const r = run({}, { axisRatio: 0.8 });
  for (const id of ['close1', 'close2', 'arms', 'extension', 'hips', 'feet']) assert.equal(find(r, id).status, 'na', id);
  assert.match(find(r, 'close1').text, /too uncertain/);
  assert.equal(find(r, 'heels').status, 'good');   // vertical: the camera angle doesn't matter
});

test('body limits follow the lifter\'s size', () => {
  // feet landing 4 cm forward: a fault for this lifter (femur 49 cm), fine for one 30 % bigger
  assert.equal(find(run({ footShift: 4 }), 'feet').status, 'fault');
  assert.equal(find(run({ footShift: 4, bodyScale: 1.3 }), 'feet').status, 'good');
});

test('a wrist the plate hides is replaced by the bar centre', () => {
  // the model puts the wrist 6 cm off the bar, inside the plate, making the elbow look bent; the hand is on the bar
  const lift = makeLift();
  for (const L of lift.poseS) { L[15].x -= 6; L[15].y -= 4; }
  load(lift);
  assert.equal(status(evaluate()).arms, 'good');
});

test('an elbow that bends just before extension is the pull under, not an early arm pull', () => {
  // full extension is at f32; a bend at f31 is 33 ms before it
  assert.equal(find(run({ elbowOut: i => i === 31 ? 25 : 0 }), 'arms').status, 'good');
  assert.equal(find(run({ elbowOut: i => i >= 24 && i <= 28 ? 25 : 0 }), 'arms').status, 'fault');
});

test('jerk: a dip that drifts forward is a fault', () => {
  const r = run({ n: 91, height: cjHeight, barX: i => i > 63 && i <= 66 ? (i - 63) * 2.5 : i > 66 ? 7.5 : 0 }, { lift: 'cj' });
  assert.equal(find(r, 'dip').status, 'fault');
});

test('a bar that rolls during the set-up: drift is measured from where it leaves the floor', () => {
  const roll = i => i < 5 ? i : 4;   // rolls 4 cm forward before lift-off, then rises straight
  assert.equal(find(run({ barX: roll, shoulderX: roll }), 'close1').status, 'good');
  assert.equal(find(run({ barX: roll, shoulderX: roll }), 'close2').status, 'good');
});
