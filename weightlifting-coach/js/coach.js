/* Local AI coach: an OpenAI-compatible chat endpoint on this machine (LM Studio, Ollama). It gets a compact
   summary of the analysed lift and the coaching notes for the faults found, and answers in a fixed JSON shape.
   Nothing here touches the DOM except through the functions app.js passes in, so it runs under Node too. */
import { CONFIG } from './config.js';

/* ---------- Summary of a lift (only numbers the app measured) ---------- */

const r1 = v => v == null || !isFinite(v) ? null : Math.round(v * 10) / 10;
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;

/* a = analyse(), ph = barPhases(), tech = evaluate(), c = cm per px, t(i) = frame time (s),
   angles(i) = { hip, knee, elbow, backFromVertical } or null, history = earlier saved lifts (library records). */
export function summarise({ lift, weightKg, a, ph, tech, c, t, angles, history = [], reference = [] }) {
  const f = i => i == null ? null : { frame: i, timeS: r2(t(i)) };
  const k = tech && tech.keys || {};
  const at = i => i == null ? null : (() => { const g = angles(i); return g ? { frame: i, ...Object.fromEntries(Object.entries(g).map(([n, v]) => [n, r1(v)])) } : null; })();
  return {
    lift, weightKg: weightKg ?? null,
    camera: tech && tech.axisRatio != null ? { plateWidthOverHeight: r2(tech.axisRatio), sideOn: tech.axisRatio >= CONFIG.checks.mixedPlaneMinRatio } : null,
    phases: {
      liftoff: f(ph.liftoff), barAtKnee: f(k.knee), fullExtension: f(k.ext), peakSpeed: f(a.vIdx),
      peak: f(a.peak), received: f(a.receive), catch: f(a.catchIdx), ...(a.jerk ? { jerkDipBottom: f(a.jerk.dipBottom), jerkLockout: f(a.jerk.top) } : {}),
    },
    bar: {
      pullHeightCm: r1(a.height * c), dropToCatchCm: r1(a.drop * c), rideDownCm: r1(a.rideDown * c),
      towardLifterCm: r1(a.toward * c), awayFromLifterCm: r1(a.away * c), catchVsStartCm: r1(a.catchD * c),
      peakSpeedMs: r2(a.vMax), pullTimeS: r2(a.pullTime), turnoverTimeS: r2(a.turnoverTime),
      ...(a.peakPower != null ? { peakPowerW: Math.round(a.peakPower) } : {}),
    },
    angles: { atLiftoff: at(ph.liftoff), atKnee: at(k.knee), atFullExtension: at(k.ext), atCatch: at(a.catchIdx) },
    findings: (tech && tech.checks || []).filter(x => x.status !== 'info' || x.id === 'turnover')
      .map(x => ({ id: x.id, title: x.title, status: x.status, confidence: x.confidence, frame: x.frame, measured: x.text,
                   ...(x.status === 'na' || (x.confidence ?? 1) < CONFIG.coach.lowConfidence ? { uncertain: true } : {}) })),
    // this lift next to published elite ranges (knowledge/good-lift.md): mean ± SD of elite competition lifts
    referenceRanges: reference.map(r => ({ id: r.id, label: r.label, value: r.unit === 'm/s' ? r2(r.value) : r1(r.value), unit: r.unit,
      eliteMean: r.mean, eliteSd: r.sd, where: r.where, source: r.source })),
    history: history.slice(0, CONFIG.coach.historyLifts).map(r => ({
      date: r.date, weightKg: r.weightKg ?? null,
      pullHeightCm: r.stats ? r.stats.height : null, dropToCatchCm: r.stats ? r.stats.drop : null, peakSpeedMs: r.stats ? r.stats.vMax ?? null : null,
      faults: (r.findings || []).filter(x => x.status === 'fault').map(x => x.id),
      watch: (r.findings || []).filter(x => x.status === 'watch').map(x => x.id),
    })),
  };
}

/* ---------- Coaching notes ---------- */

/* The part of knowledge/good-lift.md for a lift: how to read the numbers, and that lift's positions and
   measured ranges (the jerk too for a clean & jerk). */
export function referenceFor(md, lift) {
  const parts = md.split(/\n(?=## )/);
  const want = { snatch: ['Snatch'], clean: ['Clean'], cj: ['Clean', 'Jerk'] }[lift] || [];
  const intro = parts[0].replace(/^# .*\n/, '').trim();
  return [intro, ...parts.filter(p => want.some(w => p.startsWith(`## ${w}`)))].join('\n\n');
}

/* "General" and the sections of knowledge/coaching.md for the given fault ids. */
export function notesFor(md, ids) {
  const parts = md.split(/\n(?=## )/), want = new Set(['General', ...ids]);
  return parts.filter(p => { const m = p.match(/^## (\w+)/); return m && want.has(m[1]); }).join('\n\n');
}

/* ---------- The request ---------- */

export const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['main_issue_id', 'main_issue', 'causal_chain', 'cues', 'drill', 'evidence', 'watch_next_session', 'uncertainty'],
  properties: {
    main_issue_id: { type: 'string', description: 'The id of the finding the main issue is about, or "none".' },
    main_issue: { type: 'string', description: 'The one thing to work on first, in one or two sentences.' },
    causal_chain: { type: 'array', items: { type: 'string' }, description: 'How the main issue leads to the other findings, earliest first.' },
    cues: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    drill: { type: 'object', additionalProperties: false, required: ['name', 'how'], properties: { name: { type: 'string' }, how: { type: 'string' } } },
    evidence: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['claim', 'frame', 'value'],
        properties: { claim: { type: 'string' }, frame: { type: 'integer' }, value: { type: 'string', description: 'A measured value from the input, with its unit.' } },
      },
    },
    watch_next_session: { type: 'string' },
    uncertainty: { type: 'string', description: 'What in the data is uncertain, or "none".' },
  },
};

/* Findings the main issue may be about: faults and watches the inputs can back up. */
export const candidates = summary => summary.findings.filter(f => (f.status === 'fault' || f.status === 'watch') && !f.uncertain).map(f => f.id);

/* The schema for one lift: main_issue_id can only name a finding that isn't uncertain. Servers that support
   structured output (Ollama, LM Studio) apply it as a grammar, so the model can't pick an uncertain one. */
export function schemaFor(summary) {
  const s = structuredClone(SCHEMA);
  s.properties.main_issue_id.enum = [...candidates(summary), 'none'];
  return s;
}

const RULES = `You are an assistant to a weightlifting coach. You get one lift measured from video, as JSON, and coaching notes.
Rules:
- Use only numbers that appear in the input JSON, written exactly as they appear there, with their units. Never estimate, convert or invent a number.
- Every evidence item cites a frame number from the input and a measured value from the input.
- Findings marked "uncertain": true must not be the main issue or the start of the causal chain. Mention them only in "uncertainty". If every fault is uncertain, say the video can't support a main issue and what to film differently.
- Pick one main issue: the earliest fault in the lift that explains the others, per the notes. At most two cues, short and concrete.
- The drill must come from the coaching notes.
- "referenceRanges" compares this lift with published elite ranges. Use them as context, not targets: they are elite lifts near their best, lighter lifts are faster and higher, taller lifters pull higher, and the bar path type is not a grade. A value outside a range is not a fault by itself.
- Make no medical, injury or pain claims and give no medical advice.
- If there is no clear fault, say the lift looks sound and name the next thing to watch.
Answer with JSON only, matching the schema.`;

export function buildMessages(summary, notes, reference = '') {
  return [
    { role: 'system', content: `${RULES}\n\nCoaching notes (a draft, not yet reviewed by a coach):\n${notes}${reference ? `\n\nWhat a good lift looks like, with published elite measurements:\n${reference}` : ''}` },
    { role: 'user', content: `Lift:\n${JSON.stringify(summary)}\n\nJSON schema for the answer:\n${JSON.stringify(schemaFor(summary))}` },
  ];
}

/* ---------- Checking the answer ---------- */

/* The answer's JSON object, from raw model text: drops reasoning blocks and code fences. */
export function parseAnswer(text) {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('the model did not answer with JSON');
  return JSON.parse(s.slice(a, b + 1));
}

const numbersIn = s => (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
function allNumbers(o, out = []) {
  if (typeof o === 'number') out.push(o);
  else if (typeof o === 'string') out.push(...numbersIn(o));
  else if (o && typeof o === 'object') for (const v of Object.values(o)) allNumbers(v, out);
  return out;
}

/* Problems with an answer: missing fields, too many cues, frames or numbers that aren't in the summary.
   Small integers (1, 2, a set count …) are allowed in the advice. */
export function checkAnswer(ans, summary) {
  const issues = [];
  for (const k of SCHEMA.required) if (ans[k] == null) issues.push(`missing "${k}"`);
  if (ans.main_issue_id != null && ![...candidates(summary), 'none'].includes(ans.main_issue_id))
    issues.push(`the main issue is about "${ans.main_issue_id}", which the measurements can't back up`);
  if (Array.isArray(ans.cues) && ans.cues.length > 2) issues.push('more than two cues');
  const known = allNumbers(summary), has = n => known.some(k => Math.abs(k - n) < 0.051 || Math.abs(Math.abs(k) - Math.abs(n)) < 0.051);
  const frames = new Set(); (function walk(o) { if (o && typeof o === 'object') for (const [key, v] of Object.entries(o)) { if (key === 'frame' && Number.isInteger(v)) frames.add(v); else walk(v); } })(summary);
  for (const e of ans.evidence || []) {
    if (!frames.has(e.frame)) issues.push(`evidence cites frame ${e.frame}, which isn't in the measurements`);
    const n = numbersIn(e.value);
    if (!n.length) issues.push(`evidence "${e.claim}" has no measured value`);
    for (const v of n) if (!has(v)) issues.push(`${v} (in "${e.value}") isn't a measured value`);
  }
  const prose = [ans.main_issue, ...(ans.causal_chain || []), ...(ans.cues || []), ans.watch_next_session, ...(ans.evidence || []).map(e => e.claim)];
  for (const v of prose.flatMap(numbersIn)) if (Math.abs(v) > 3 && !has(v) && !frames.has(v)) issues.push(`${v} in the text isn't a measured value`);
  return [...new Set(issues)];
}

/* ---------- Talking to the endpoint ---------- */

const base = url => url.replace(/\/+$/, '');

/* Model ids the endpoint offers, or null if it doesn't answer. */
export async function listModels(url) {
  try {
    const r = await fetch(base(url) + '/models', { signal: AbortSignal.timeout(CONFIG.coach.connectMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.data || []).map(m => m.id);
  } catch (_) { return null; }
}

/* One chat completion. With a schema, asks for structured output and retries without it if the server refuses. */
export async function chat({ url, model }, messages, schema = null) {
  const json = !!schema;
  const body = { model, messages, temperature: 0.2, stream: false };
  const send = b => fetch(base(url) + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    signal: AbortSignal.timeout(CONFIG.coach.answerMs),
  });
  let r = await send(json ? { ...body, response_format: { type: 'json_schema', json_schema: { name: 'coaching', strict: true, schema } } } : body);
  if (!r.ok && json && r.status >= 400 && r.status < 500) r = await send(body);   // no structured output on this server
  if (!r.ok) throw new Error(`the coach endpoint answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices[0].message.content;
}
