import { $, S, busy } from './state.js';
import { CONFIG } from './config.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from './path.js';
import { compare, measures } from './reference.js';
import { TRIPLE, jointAng, jp, lean } from './pose.js';
import * as db from './storage.js';
import { goto } from './app.js';
import { buildMessages, chat, checkAnswer, listModels, notesFor, parseAnswer, referenceFor, schemaFor, summarise } from './coach.js';

/* ---------- Coach tab ---------- */

const KEY = 'wl-coach-coach', OLD_KEY = 'barpath-coach';   // settings saved under the app's old name still count
const cfg = { url: CONFIG.coach.url, model: CONFIG.coach.model };
try { Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || '{}')); } catch (_) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = (t, warn) => { $('coachStatus').textContent = t; $('coachStatus').classList.toggle('warn', !!warn); };

let ready = false, working = false, thread = null, summary = null, notesMd = null, goodMd = null;

function refresh() {
  const lifted = !!(S.tech && S.tech.checks);
  $('btnCoach').disabled = !ready || working || !lifted || busy();
  $('btnCoachSend').disabled = !ready || working || !thread;
  $('btnCoach').textContent = working ? 'Thinking…' : 'Ask the coach';
}

async function connect() {
  cfg.url = $('coachUrl').value.trim() || CONFIG.coach.url;
  status(`Looking for a model at ${cfg.url}…`);
  const models = await listModels(cfg.url);
  ready = !!(models && models.length);
  const sel = $('coachModel');
  sel.innerHTML = (models || []).map(m => `<option>${esc(m)}</option>`).join('');
  if (ready) {
    if (!models.includes(cfg.model)) cfg.model = models[0];
    sel.value = cfg.model;
    status(`Connected: ${models.length} model${models.length === 1 ? '' : 's'} at ${cfg.url}.`);
  } else status(models ? `The endpoint answers but has no model loaded. Load one in LM Studio or Ollama, then Connect.`
    : `No model server at ${cfg.url}. Start LM Studio's server (port 1234) or Ollama (http://localhost:11434/v1), then Connect.`, true);
  save(); refresh();
}

// joint angles on frame i, only from joints the body model saw
const minV = CONFIG.checks.minVis;
const seen = (i, names) => names.every(n => { const p = jp(i, n); return p && p.v >= minV; });
function angles(i) {
  if (!S.poseS[i]) return null;
  const out = {};
  for (const j of ['hip', 'knee', 'elbow']) if (seen(i, TRIPLE[j])) out[j] = jointAng(i, j);
  if (seen(i, ['shoulder', 'hip'])) out.backFromVertical = lean(i);
  return Object.keys(out).length ? out : null;
}

async function ask() {
  if (!ready || working || !S.tech || !S.tech.checks) return;
  working = true; refresh();
  $('coachOut').hidden = false; $('coachAnswer').innerHTML = '<p class="note">The model is reading the lift. On a laptop this can take a minute or two.</p>';
  try {
    notesMd ??= await (await fetch(new URL('../knowledge/coaching.md', import.meta.url))).text();
    goodMd ??= await (await fetch(new URL('../knowledge/good-lift.md', import.meta.url))).text();
    const pts = pathPoints(), an = analyse(pts), ph = barPhases(pts);
    const reference = an && ph ? compare(S.lift, measures(an, ph, pts, cmPerPx(), S.facing, S.axisRatio || 1)) : [];
    const lifts = (await db.listLifts()).filter(r => r.lift === S.lift && r.id !== S.recordId).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    summary = summarise({ lift: S.lift, weightKg: S.kg, a: an, ph, tech: S.tech, c: cmPerPx(), t: timeOf, angles, history: lifts, reference });
    const faults = S.tech.checks.filter(c => c.status === 'fault' || c.status === 'watch').map(c => c.id);
    thread = buildMessages(summary, notesFor(notesMd, [...faults, 'turnover']), referenceFor(goodMd, S.lift));
    const t0 = performance.now(), text = await chat(cfg, thread, schemaFor(summary));
    const ans = parseAnswer(text);
    thread.push({ role: 'assistant', content: JSON.stringify(ans) });
    render(ans, checkAnswer(ans, summary), (performance.now() - t0) / 1000);
    $('coachChat').hidden = false; $('coachThread').innerHTML = '';
  } catch (e) {
    $('coachAnswer').innerHTML = `<p class="note warn">The coach couldn't answer: ${esc(e.message || e)}</p>`;
    thread = null;
  }
  working = false; refresh();
}

function render(a, issues, secs) {
  const cite = e => `<li>${esc(e.claim)} <button class="cite" data-frame="${Number(e.frame)}">f ${esc(e.frame)} · ${esc(e.value)}</button></li>`;
  $('coachAnswer').innerHTML = `<div class="coach">
    <p class="main">${esc(a.main_issue)}</p>
    ${a.causal_chain && a.causal_chain.length ? `<h3>How it connects</h3><ol>${a.causal_chain.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${a.cues && a.cues.length ? `<h3>Cues</h3><ul>${a.cues.slice(0, 2).map(x => `<li>“${esc(x)}”</li>`).join('')}</ul>` : ''}
    ${a.drill ? `<h3>Drill</h3><p><b>${esc(a.drill.name)}</b>: ${esc(a.drill.how)}</p>` : ''}
    ${a.evidence && a.evidence.length ? `<h3>Evidence</h3><ul>${a.evidence.map(cite).join('')}</ul>` : ''}
    ${a.watch_next_session ? `<h3>Next session</h3><p>${esc(a.watch_next_session)}</p>` : ''}
    ${a.uncertainty && !/^none\.?$/i.test(a.uncertainty.trim()) ? `<h3>Uncertain</h3><p>${esc(a.uncertainty)}</p>` : ''}
    ${issues.length ? `<p class="warn">Check this answer: ${issues.map(esc).join('; ')}.</p>` : ''}
    <p class="note">${esc(cfg.model)} · ${secs.toFixed(0)} s · click a frame to see it.</p>
  </div>`;
}

async function followUp() {
  const q = $('coachQ').value.trim();
  if (!q || !thread || working) return;
  working = true; refresh();
  const box = $('coachThread');
  box.insertAdjacentHTML('beforeend', `<div class="thread"><p class="q">${esc(q)}</p><p class="a note">…</p></div>`);
  const a = box.lastElementChild.querySelector('.a');
  thread.push({ role: 'user', content: `${q}\n\n(Answer in plain text, briefly, about this lift only. Same rules: only numbers from the lift data, cite frames as "f 123", no medical claims.)` });
  try {
    const text = (await chat(cfg, thread)).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    thread.push({ role: 'assistant', content: text });
    const bad = checkAnswer({ main_issue: text, causal_chain: [], cues: [], drill: {}, evidence: [], watch_next_session: '', uncertainty: '' }, summary).filter(x => /text isn't/.test(x));
    a.classList.remove('note');
    a.innerHTML = esc(text).replace(/\bf (\d+)\b/g, (m, f) => `<button class="cite" data-frame="${f}">f ${f}</button>`) + (bad.length ? `<br><span class="warn">Check: ${bad.map(esc).join('; ')}.</span>` : '');
    $('coachQ').value = '';
  } catch (e) {
    thread.pop(); a.textContent = `No answer: ${e.message || e}`; a.classList.add('warn');
  }
  working = false; refresh();
}

$('coachUrl').value = cfg.url;
$('btnCoachConnect').onclick = connect;
$('coachModel').onchange = e => { cfg.model = e.target.value; save(); };
$('btnCoach').onclick = ask;
$('btnCoachSend').onclick = followUp;
$('coachQ').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); followUp(); } });
$('panelCoach').addEventListener('click', e => { const b = e.target.closest('.cite'); if (b) goto(+b.dataset.frame); });
$('tabCoach').addEventListener('click', () => { refresh(); if (!ready) connect(); });
connect();
