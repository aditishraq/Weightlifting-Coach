import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../js/state.js';
import { analyse, barPhases, cmPerPx, pathPoints } from '../js/path.js';
import { REFERENCE, compare, measures } from '../js/reference.js';
import { cjHeight, load, makeLift } from './lift.js';

const run = (o, opts) => { load(makeLift(o), opts); const pts = pathPoints(); return measures(analyse(pts), barPhases(pts), pts, cmPerPx(), S.facing); };

test('measures of a snatch: sweep back, loop, catch, height, drop, catch height', () => {
  // back 5 cm by f20, forward to 2 cm in front by f38, then caught 8 cm back; bar 100 cm up, caught at 85
  const barX = i => i <= 6 ? 0 : i <= 20 ? -5 * (i - 6) / 14 : i <= 38 ? -5 + 7 * (i - 20) / 18 : i <= 50 ? 2 - 10 * (i - 38) / 12 : -8;
  const m = run({ barX });
  assert.ok(Math.abs(m.sweepBack - 5) < 0.3, String(m.sweepBack));
  assert.ok(Math.abs(m.loop - 7) < 0.5, String(m.loop));
  assert.ok(Math.abs(m.catchBack - 8) < 0.5, String(m.catchBack));
  assert.ok(Math.abs(m.pullHeight - 100) < 0.5 && Math.abs(m.drop - 15) < 1, `${m.pullHeight} ${m.drop}`);
  assert.ok(Math.abs(m.catchRel - 85) < 1, String(m.catchRel));
});

test('compared with the elite ranges, mirrored lifters measure the same', () => {
  const barX = i => i <= 6 ? 0 : i <= 20 ? -5 * (i - 6) / 14 : -5;
  const a = compare('snatch', run({ barX })), b = compare('snatch', run({ barX, facing: -1 }));
  assert.deepEqual(a.map(r => r.id), REFERENCE.snatch.map(r => r.id));
  for (const [i, r] of a.entries()) assert.ok(Math.abs(r.value - b[i].value) < 1e-9, r.id);
  assert.equal(a.find(r => r.id === 'catchRel').where, 'within');   // 85 %
  assert.equal(a.find(r => r.id === 'peakSpeed').where, 'below');   // the test lift peaks at 0.86 m/s
});

test('the clean has no published ranges; the jerk is compared on its drive', () => {
  assert.deepEqual(compare('clean', run({})), []);
  const m = run({ n: 91, height: cjHeight }, { lift: 'cj' });
  assert.ok(m.driveSpeed > 1 && Math.abs(m.dipDepth - 10) < 1.5, `${m.driveSpeed} ${m.dipDepth}`);
  assert.deepEqual(compare('cj', m).map(r => r.id), ['driveSpeed']);
});
