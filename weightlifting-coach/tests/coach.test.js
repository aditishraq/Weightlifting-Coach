import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { S } from '../js/state.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from '../js/path.js';
import { evaluate } from '../js/checks.js';
import { buildMessages, candidates, chat, checkAnswer, listModels, notesFor, parseAnswer, referenceFor, schemaFor, summarise } from '../js/coach.js';
import { load, makeLift } from './lift.js';

const notes = readFileSync('knowledge/coaching.md', 'utf8');
function lift(o = {}) {
  load(makeLift(o)); S.kg = 80; S.tech = evaluate();
  const pts = pathPoints();
  return summarise({ lift: 'snatch', weightKg: 80, a: analyse(pts), ph: barPhases(pts), tech: S.tech, c: cmPerPx(), t: timeOf,
    angles: () => ({ hip: 150.04, knee: 120 }), history: [{ date: '2026-10-01', weightKg: 75, stats: { height: 98.2, drop: 18, vMax: 1.8 }, findings: [{ id: 'close2', status: 'fault' }] }] });
}
const good = s => ({
  main_issue_id: 'none', main_issue: 'The bar drifts forward off the floor.', causal_chain: ['Bar forward before the knee', 'swings out at the hips'],
  cues: ['Sweep the bar back'], drill: { name: 'Pause pulls', how: 'Pause at mid-shin.' },
  evidence: [{ claim: 'Pull height', frame: s.phases.peak.frame, value: `${s.bar.pullHeightCm} cm` }],
  watch_next_session: 'Bar path off the floor.', uncertainty: 'none',
});

test('summary holds the lift, phases, bar figures, findings and history, rounded', () => {
  const s = lift();
  assert.equal(s.lift, 'snatch'); assert.equal(s.weightKg, 80);
  assert.deepEqual(s.phases.peak, { frame: 40, timeS: 1.33 });
  assert.equal(s.bar.pullHeightCm, 100);
  assert.equal(s.angles.atLiftoff.hip, 150);
  assert.ok(s.findings.length >= 9 && s.findings.every(f => 'confidence' in f && 'status' in f));
  assert.deepEqual(s.history[0].faults, ['close2']);
  assert.ok(s.findings.filter(f => f.status === 'na').every(f => f.uncertain));
});

test('notes: General plus the sections for the faults found', () => {
  const n = notesFor(notes, ['close1', 'feet']);
  assert.match(n, /^## General/m); assert.match(n, /^## close1/m); assert.match(n, /^## feet/m);
  assert.doesNotMatch(n, /^## lockout/m);
});

test('the prompt carries the rules, the notes, the lift and the schema', () => {
  const m = buildMessages(lift(), notesFor(notes, ['close1']));
  assert.match(m[0].content, /only numbers that appear in the input/i);
  assert.match(m[0].content, /no medical/i);
  assert.match(m[0].content, /## close1/);
  assert.match(m[1].content, /"pullHeightCm":100/);
  assert.match(m[1].content, /"main_issue"/);
});

test('answers are parsed out of reasoning blocks and code fences', () => {
  assert.deepEqual(parseAnswer('<think>hmm 42</think>\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => parseAnswer('no json here'));
});

test('a grounded answer passes the check', () => {
  const s = lift();
  assert.deepEqual(checkAnswer(good(s), s), []);
});

test('invented numbers, unknown frames and extra cues are caught', () => {
  const s = lift(), a = good(s);
  a.evidence.push({ claim: 'Bar swung out', frame: 999, value: '12.7 cm' });
  a.cues.push('a', 'b');
  a.main_issue = 'The bar swings out by 33.3 cm.';
  const issues = checkAnswer(a, s).join(' | ');
  assert.match(issues, /frame 999/); assert.match(issues, /12\.7/); assert.match(issues, /33\.3/); assert.match(issues, /more than two cues/);
});

test('talks to an OpenAI-compatible server, and retries without a schema if refused', async () => {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'qwen-test' }] }));
      const b = JSON.parse(body); seen.push(!!b.response_format);
      if (b.response_format) { res.statusCode = 400; return res.end('response_format not supported'); }
      res.end(JSON.stringify({ choices: [{ message: { content: '{"main_issue": "ok"}' } }] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1`;
  try {
    assert.deepEqual(await listModels(url), ['qwen-test']);
    assert.equal(parseAnswer(await chat({ url, model: 'qwen-test' }, [{ role: 'user', content: 'hi' }], { type: 'object' })).main_issue, 'ok');
    assert.deepEqual(seen, [true, false]);
    assert.equal(await listModels('http://127.0.0.1:9/v1'), null);
  } finally { srv.close(); }
});

test('the main issue can only name a finding the measurements back up', () => {
  const s = lift({ shoulderX: () => -10, footShift: 9 });   // shoulders: fault; feet and bar over mid-foot: fault
  s.findings.find(f => f.id === 'feet').uncertain = true;
  assert.ok(candidates(s).includes('shoulders') && !candidates(s).includes('feet'));
  assert.deepEqual(schemaFor(s).properties.main_issue_id.enum, [...candidates(s), 'none']);
  assert.match(checkAnswer({ ...good(s), main_issue_id: 'feet' }, s).join(' '), /can't back up/);
  assert.deepEqual(checkAnswer({ ...good(s), main_issue_id: 'shoulders' }, s), []);
});

test('the good-lift reference for each lift goes to the coach', () => {
  const md = readFileSync('knowledge/good-lift.md', 'utf8');
  assert.match(referenceFor(md, 'snatch'), /## Snatch/); assert.doesNotMatch(referenceFor(md, 'snatch'), /## Jerk/);
  assert.match(referenceFor(md, 'cj'), /## Clean[\s\S]*## Jerk/);
  assert.match(referenceFor(md, 'clean'), /No open elite reference ranges/);
  const m = buildMessages(lift(), '', referenceFor(md, 'snatch'));
  assert.match(m[0].content, /published elite measurements/); assert.match(m[0].content, /Cunanan/);
});
