import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../js/state.js';
import { buildDataset, cleanLabels, isLabelled, liftEntry } from '../js/dataset.js';
import { makeLift } from './lift.js';

/* A synthetic lift in the library's record format (js/library.js buildRecord). */
function record(labels, o = {}) {
  const l = makeLift(o);
  return {
    id: 'x' + Math.random(), date: '2026-10-20', lift: 'snatch', weightKg: 70, radius: 22.5, facing: 1, axisRatio: 0.98,
    video: { name: 'test.mp4', W: 720, H: 1280, fps: 30 }, first: 0,
    points: l.points.map(p => [p.x, p.y, 0]), times: l.points.map((_, i) => i / 30),
    pose: { first: 0, frames: l.poseS.map(L => L.flatMap(q => [q.x, q.y, q.z, q.v])) },
    findings: [{ id: 'close1', status: 'good', confidence: 1 }], labels,
  };
}

test('labels are cleaned to known values', () => {
  const c = cleanLabels({ outcome: 'make', rating: 4, verdicts: { close1: 'fault', feet: 'maybe', arms: '' }, notes: '  pulled early  ', junk: 1 });
  assert.deepEqual(c, { version: 1, outcome: 'make', rating: 4, verdicts: { close1: 'fault' }, notes: 'pulled early', labelledAt: null });
  assert.equal(cleanLabels({ rating: 9, outcome: 'yes' }).rating, null);
  assert.equal(isLabelled({}), false); assert.equal(isLabelled({ labels: { verdicts: { arms: '' } } }), false);
  assert.equal(isLabelled({ labels: { outcome: 'miss' } }), true);
});

test('a lift entry has frame-by-frame bar and joint series, phases, findings and labels', () => {
  const e = liftEntry(record({ outcome: 'make', rating: 5, verdicts: { close1: 'good' } }));
  const n = e.series.frame.length;
  for (const [k, col] of Object.entries(e.series)) assert.equal(col.length, n, k);
  const pk = e.series.frame.indexOf(e.phases.peak);
  assert.ok(Math.abs(e.series.barYcm[pk] - 100) < 0.5, String(e.series.barYcm[pk]));   // the synthetic bar peaks 100 cm up
  assert.equal(e.series.t[e.series.frame.indexOf(e.phases.liftoff)], 0);                 // time runs from lift-off
  assert.ok(e.series.vyMs.some(v => v > 0.5) && e.series.hipDeg.some(v => v > 170));
  assert.equal(e.phases.peak, 40); assert.ok(Math.abs(e.summary.pullHeightCm - 100) < 0.5);   // smoothed: the sharp synthetic peak rounds off a little
  assert.ok(e.findings.length >= 9 && e.findings.every(f => 'confidence' in f));
  assert.deepEqual(e.labels.verdicts, { close1: 'good' });
  assert.equal(e.bodyModel, true);
});

test('only labelled lifts go in; the export records its settings; the app state is untouched', () => {
  const keep = { points: S.points, radius: S.radius, lift: S.lift };
  const ds = buildDataset([record({ outcome: 'miss' }), record(undefined), record({ verdicts: { arms: 'fault' } })], new Date('2026-10-21T00:00:00Z'));
  assert.equal(ds.format, 'wlcoach-dataset'); assert.equal(ds.version, 1); assert.equal(ds.exportedAt, '2026-10-21T00:00:00.000Z');
  assert.equal(ds.lifts.length, 2); assert.equal(ds.counts.misses, 1); assert.equal(ds.counts.labelledVerdicts, 1);
  assert.ok(ds.analysis.checks.minVis && ds.analysis.smoothing.jerkQ);
  assert.equal(S.points, keep.points); assert.equal(S.radius, keep.radius); assert.equal(S.lift, keep.lift);
});

test('a lift without joints still gives bar series, with empty angle columns', () => {
  const rec = record({ rating: 3 }); delete rec.pose;
  const e = liftEntry(rec);
  assert.ok(e.series.barYcm.some(v => v > 90));
  assert.ok(e.series.hipDeg.every(v => v === null));
  assert.equal(e.bodyModel, false);
});
