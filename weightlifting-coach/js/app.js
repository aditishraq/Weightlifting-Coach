import { $, PLATES, S, busy, clamp, fix, tick, vctx, view } from './state.js';
import { demoSource, videoSource } from './sources.js';
import { grabGray, grabRoi, makeTracker } from './tracker.js';
import { CONFIG } from './config.js';
import { analyse, barPhases, cmPerPx, pathPoints, timeOf } from './path.js';
import { detectPose, finishPose, getPoser, poseReady, useCpu } from './pose.js';
import { detectPlate, platePrior } from './plate.js';
import { engineAnalyze, engineHealth } from './engine.js';
import { compare, measures } from './reference.js';
import { GROUPS, evaluate } from './checks.js';
import { drawOverlay } from './draw.js';
import './pwa.js';
import './coach-ui.js';
import { drawCompareView, exitCompare, libUi, onSourceChange, refreshLibrary, renderLibrary } from './library.js';

async function track() {
  const src = S.src, a = startPoint();
  if (!src || !a || busy()) return;
  if (S.playing) await pause();
  S.tracking = true; S.stop = false; setMsg(''); ui();
  const T = CONFIG.tracking;
  const s = clamp(T.workScalePx / S.radius, 0.1, 1);
  const ts = clamp(Math.round(T.tplRadii * S.radius * s) | 1, 15, 61);
  const tk = await makeTracker({ ...T, fps: src.fps });
  const stamp = (i, t) => { if (t != null) S.times[i] = t; };
  stamp(a.frame, await src.seek(a.frame)); S.frame = a.frame;
  const fail = m => { tk.close(); setMsg(m, true); S.tracking = false; ui(); render(); };
  const err = await tk.init(grabGray(s), a.x, a.y, ts, S.radius);
  if (err) return fail(err);
  S.points.length = a.frame;
  S.points[a.frame] = { x: a.x, y: a.y, score: 1 };
  S.trackSource = 'browser';
  let lastGood = a.frame, lost = false, refound = 0;
  for (let i = a.frame + 1; i < src.N; i++) {
    if (S.stop) break;
    stamp(i, await src.seek(i)); S.frame = i;
    const r = await tk.step(grabGray(s));
    if (r.lost) { lost = true; break; }
    if (r.low) S.points[i] = { x: r.x, y: r.y, score: r.score, low: true };
    else {
      // refine the centre at full resolution on this frame, before moving on
      const f = await tk.finish(grabRoi(r.x, r.y, S.radius * 1.15 + 4));
      S.points[i] = { x: f.x, y: f.y, score: r.score };
      lastGood = i;
    }
    if (r.refound) refound++;
    $('bar').style.width = ((i - a.frame) / Math.max(1, src.N - 1 - a.frame) * 100) + '%';
    render();
    if (src.kind === 'demo') await tick();
  }
  tk.close();
  S.points.length = lastGood + 1;
  S.tracking = false;
  const n = S.points.filter(Boolean).length, rf = refound ? ` Re-found the plate ${refound === 1 ? 'once' : refound + ' times'} after losing it.` : '';
  refreshTech();
  if (lost) {
    setMsg(`Lost the bar after frame ${lastGood}.${rf} Go to that frame, click the bar end again, and track from there.`, true);
    await goto(lastGood);
  } else {
    setMsg((S.stop ? `Stopped. ${n} frames tracked.` : `Tracked ${n} frames.`) + rf);
    await goto(S.frame);
  }
  ui();
}

function fmt(px, signed) {
  const mm = S.scaleOn ? 225 / S.radius : 0;
  if (mm) {
    const v = px * mm / 10;
    return `${(signed ? Math.abs(v) : v).toFixed(1)}<small> cm</small>`;
  }
  return `${Math.round(signed ? Math.abs(px) : px)}<small> px</small>`;
}
const dirWord = d => d > 0.5 ? 'away' : d < -0.5 ? 'toward' : '';

function renderStats() {
  const pts = pathPoints(), a = analyse(pts);
  const el = $('stats');
  renderReference(a, pts);
  if (!a) {
    el.innerHTML = '<div class="wide"><dd class="note" style="font:inherit">Track a lift to see how far the bar drifts from vertical.</dd></div>';
    $('statsNote').textContent = '';
    return;
  }
  const cd = dirWord(a.catchD), jd = a.jerkD == null ? '' : dirWord(a.jerkD);
  // velocity, timing and power need the plate scale
  const si = S.scaleOn && a.vMax != null, sec = t => `${t.toFixed(2)}<small> s</small>`;
  const watts = p => `${Math.round(p)}<small> W</small>`;
  el.innerHTML = `
    <div><dt>Toward lifter</dt><dd>${fmt(a.toward)}</dd></div>
    <div><dt>Away from lifter</dt><dd>${fmt(a.away)}</dd></div>
    <div><dt>Pull height</dt><dd>${fmt(a.height)}</dd></div>
    <div><dt>Drop to catch</dt><dd>${fmt(a.drop)}${a.rideDown * cmPerPx() > 2 ? `<small> + ${fmt(a.rideDown).replace(/<\/?small>/g, '')} ride down</small>` : ''}</dd></div>
    <div><dt>Catch vs start</dt><dd>${fmt(a.catchD, true)}${cd ? `<small> ${cd}</small>` : ''}</dd></div>
    <div><dt>Horizontal range</dt><dd>${fmt(a.range)}</dd></div>
    ${a.jerkD == null ? '' : `<div class="wide"><dt>Jerk: lockout vs dip</dt><dd>${fmt(a.jerkD, true)}${jd ? `<small> ${jd}</small>` : ''}</dd></div>`}
    ${si ? `<div class="wide"><dt>Peak bar speed (up)</dt><dd>${a.vMax.toFixed(2)}<small> m/s · f ${a.vIdx}, ${fmt(a.vHeight)} up</small></dd></div>
    <div><dt>Pull time</dt><dd>${sec(a.pullTime)}</dd></div>
    <div><dt>Turnover time</dt><dd>${sec(a.turnoverTime)}</dd></div>
    ${a.peakPower != null ? `<div><dt>Peak power</dt><dd>${watts(a.peakPower)}</dd></div><div><dt>Mean pull power</dt><dd>${watts(a.meanPower)}</dd></div>` : ''}` : ''}
    <div class="wide"><dt>Frames</dt><dd style="font-size:14px">${a.count} tracked${a.lowCount ? ` · ${a.lowCount} low confidence` : ''} · lift f ${a.begin}–${a.end}, pull peaks f ${a.peak}, received f ${a.receive}, catch f ${a.catchIdx}</dd></div>`;
  $('statsNote').textContent = (S.lift === 'cj'
    ? (a.jerk ? 'Horizontal figures cover the clean, from the floor to the catch. The jerk is measured separately.' : 'Horizontal figures cover the clean. No jerk found in the tracked frames; track through the lockout to include it.')
    : 'Horizontal figures cover the lift from the floor to the bottom of the catch.')
    + ' Drop to catch is from the top of the pull to where the bar is received; ride down is how far it sinks with the lifter after that.'
    + (si ? ' Pull time runs from lift-off to peak bar speed, turnover from there to the receive.' + (a.peakPower == null ? ' Enter the bar weight for power.' : '') : '');
}

/* This lift next to the elite ranges in knowledge/good-lift.md. */
function renderReference(a, pts) {
  const box = $('refBox');
  const ph = a && barPhases(pts);
  if (!a || !ph || ph.liftoff == null || !S.scaleOn) { box.innerHTML = ''; return; }
  const rows = compare(S.lift, measures(a, ph, pts, cmPerPx(), S.facing, S.axisRatio || 1));
  if (!rows.length) {
    box.innerHTML = S.lift === 'clean' ? '<p class="note">No published elite ranges were found for the clean\'s bar path, so there is nothing to compare it with (knowledge/good-lift.md).</p>' : '';
    return;
  }
  const fmtV = (v, u) => u === 'm/s' ? v.toFixed(2) : v.toFixed(1);
  const word = { within: 'within', below: 'below', above: 'above' };
  box.innerHTML = `<h3 class="sub-h">Compared with elite lifts</h3><table class="ref">${rows.map(r => `
    <tr><td>${r.label}<br><small class="note">${r.what}</small></td>
      <td class="v">${fmtV(r.value, r.unit)} ${r.unit}</td>
      <td class="v">elite ${fmtV(r.mean, r.unit)} ± ${fmtV(r.sd, r.unit)}<br><span class="${r.where}">${word[r.where]}</span></td></tr>`).join('')}</table>
    <p class="note">Elite competition lifts near their best, side-on (${[...new Set(rows.map(r => r.source.split(' (')[0]))].join(', ')}; details in knowledge/good-lift.md). They describe elite lifts, not targets: lighter lifts are faster and higher, taller lifters pull higher, and elite lifters succeed with all bar path types.${S.axisRatio != null && S.axisRatio < CONFIG.checks.mixedPlaneMinRatio ? ' The camera wasn\'t side-on here, so the horizontal figures are less certain.' : ''}</p>`;
}

/* Bar weight in kg, shared by the readout (for power) and the save form. */
export function setKg(v) {
  $('barKg').value = $('saveKg').value = v;
  S.kg = parseFloat(v) || null;
}
for (const id of ['barKg', 'saveKg']) $(id).addEventListener('input', e => { setKg(e.target.value); if (!busy()) renderStats(); });

async function runPose() {
  const src = S.src;
  const first = S.points.findIndex(Boolean), last = S.points.length - 1;
  if (!src || first < 0 || busy()) return;
  if (S.playing) await pause();
  S.analysing = true; S.poseStop = false; ui();
  const msg = (t, warn) => { const m = $('poseMsg'); m.textContent = t; m.classList.toggle('warn', !!warn); };
  msg('Loading the body-tracking model…');
  try { await getPoser(); }
  catch (e) {
    S.analysing = false; ui();
    msg(`Could not load the body-tracking model (${e.message || e}). Reload the page and try again.`, true);
    return;
  }
  msg('Finding the lifter on each tracked frame…');
  let found = 0, done = 0;
  try {
    for (let i = first; i <= last; i++) {
      if (S.poseStop) break;
      if (!S.pose[i]) {
        const t = await src.seek(i); if (t != null) S.times[i] = t; S.frame = i;
        let L;
        try { L = detectPose(src, timeOf(i)); }
        catch (e) {
          if (!(await useCpu())) throw e;
          L = detectPose(src, timeOf(i));
        }
        S.pose[i] = L; S.poseS[i] = L;
        render();
      }
      if (S.pose[i]) found++;
      done++;
      $('poseBar').style.width = (done / (last - first + 1) * 100) + '%';
      await tick();
    }
  } catch (e) {
    S.analysing = false; ui();
    msg(/webgl|activeTexture/i.test(String(e && e.message))
      ? 'Body tracking needs WebGL, which is turned off or unavailable in this browser. Try Chrome, Edge or Safari with hardware acceleration on.'
      : `Body tracking stopped: ${e.message || e}`, true);
    return;
  }
  const face = finishPose();
  S.analysing = false;
  if (!found) {
    msg('No lifter found in the tracked frames. The whole body needs to be in shot, side-on.', true);
  } else {
    let t = `Body found on ${found} of ${done} frames.`;
    if (face !== 0) { setFacing(face > 0 ? 1 : -1, true); t += ` Lifter faces ${face > 0 ? 'right' : 'left'}.`; }
    msg(t);
  }
  refreshTech();
  await goto(S.frame);
  ui();
}

/* ---------- Plate finder ---------- */

/* Looks for the plate on the current frame. The body model, when it runs, gives the plate's expected size, the
   floor and the hands; auto (on opening a video) uses it only if it is already loaded, so nothing is downloaded
   unasked. */
async function findPlate(auto = false) {
  const src = S.src;
  if (!src || src.kind !== 'video' || busy()) return;
  if (S.playing) await pause();
  S.finding = true; ui();
  const msg = (t, warn) => { $('findMsg').textContent = t; $('findMsg').classList.toggle('warn', !!warn); };
  msg(auto ? '' : 'Looking for the plate…');
  const frame = S.frame;
  try {
    let prior = null;
    if (!auto || poseReady()) {
      try {
        if (!poseReady()) msg('Loading the body-tracking model…');
        await getPoser();
        await src.seek(frame);
        prior = platePrior(detectPose(src, timeOf(frame)));
      } catch (_) { prior = null; }
    }
    await src.seek(frame);
    const D = CONFIG.detect, k = Math.min(1, D.workPx / Math.max(src.W, src.H));
    const list = detectPlate(grabGray(k), (x, y, h) => grabRoi(x, y, h, true), src.W, src.H, prior || {});
    S.finding = false;
    if (!list.length) {
      S.suggest = null; $('suggest').hidden = true;
      if (!auto) msg('No plate found on this frame. Click the centre of the sleeve and drag out to the rim.', true);
      else msg('');
    } else {
      S.suggest = { list, i: 0, frame, prior: !!prior };
      msg('');
      showSuggestion();
    }
  } catch (e) {
    S.finding = false;
    msg(`The plate finder stopped: ${e.message || e}`, true);
  }
  render(); ui();
}

function showSuggestion() {
  const g = S.suggest, p = g.list[g.i], D = CONFIG.detect;
  S.anchor = { x: p.x, y: p.y, frame: g.frame };
  setRadius(Math.round(p.r * 10) / 10);
  S.axisRatio = p.ratio;   // the checks use it to judge how side-on the camera is
  const sure = p.score >= D.minScore;
  let t = `${sure ? 'Found' : 'Best guess for'} the plate: ${Math.round(p.r)} px radius, ${Math.round(p.score * 100)} % match` +
    `${g.prior ? '' : ' (without the body model)'}${g.list.length > 1 ? `, guess ${g.i + 1} of ${g.list.length}` : ''}.`;
  if (p.ratio < D.ellipseWarn)
    t += ` The plate looks oval (width ÷ height ${p.ratio.toFixed(2)}), so the camera isn't side-on: horizontal distances will read about ${Math.round((1 - p.ratio) * 100)} % short. Turn the camera to face the plate squarely if you can.`;
  $('suggestMsg').textContent = t;
  $('suggest').hidden = false;
  $('btnNextGuess').hidden = g.list.length < 2;
}

function closeSuggestion() { $('suggest').hidden = true; }

$('btnFind').onclick = () => findPlate();
$('btnUse').onclick = () => { closeSuggestion(); track(); };
$('btnAdjust').onclick = () => {
  closeSuggestion();
  $('findMsg').textContent = 'Click the centre of the sleeve to move the mark, or drag out to the rim to resize it. Then press Track.';
};
$('btnNextGuess').onclick = () => { S.suggest.i = (S.suggest.i + 1) % S.suggest.list.length; showSuggestion(); render(); ui(); };

/* ---------- Local engine ---------- */

/* Shows the engine button when the engine answers on this machine. */
async function checkEngine() {
  S.engine = await engineHealth();
  $('engineRow').hidden = !S.engine;
  if (S.engine && !S.engine.ok) { $('engineMsg').hidden = false; $('engineMsg').textContent = `The local engine is running but failed to load its models: ${S.engine.error}`; }
  ui();
}

/* Sends the video to the local engine (127.0.0.1 only) and loads its measurements as if tracked here. */
async function runEngine() {
  const src = S.src;
  if (!src || src.kind !== 'video' || !src.file || busy()) return;
  if (S.playing) await pause();
  const msg = (t, warn) => { const m = $('engineMsg'); m.hidden = false; m.textContent = t; m.classList.toggle('warn', !!warn); };
  S.engineBusy = true; ui();
  // the plate the app found or you marked: the mark on this frame, else where the tracked path starts, so the
  // engine uses the app's radius (scale) even if the video has moved on since
  const first = S.points.findIndex(Boolean);
  const a = S.anchor && S.anchor.frame === S.frame ? S.anchor
    : first >= 0 ? { x: S.points[first].x, y: S.points[first].y, frame: first }
    : S.anchor;
  try {
    const res = await engineAnalyze(src.file, {
      lift: S.lift, facing: S.facing, weightKg: S.kg,
      hint: a ? { frame: a.frame, x: a.x, y: a.y, r: S.radius } : null,
    }, (stage, p) => { msg(`${stage}… ${Math.round(p * 100)} %`); $('bar').style.width = (p * 100) + '%'; });
    loadResult(res);
    S.engineResult = res; S.trackSource = 'engine';   // the raw result, kept for saving and export
    msg(`Engine: ${res.points.filter(Boolean).length} frames measured with ${res.producer.models.tracker} on ${res.producer.device} in ${res.producer.seconds} s.` +
      (res.plate.axisRatio < CONFIG.detect.ellipseWarn ? ` The plate looks oval (width ÷ height ${res.plate.axisRatio.toFixed(2)}): the camera isn't side-on.` : ''));
  } catch (e) {
    msg(`The local engine stopped: ${e.message || e}`, true);
  }
  S.engineBusy = false;
  render(); ui();
}

/* Loads a result object (docs/result-format.md) into the tracked state. */
export function loadResult(res) {
  S.points = []; S.times = []; S.anchor = null; S.suggest = null; closeSuggestion();
  // the result's frames are the video's decoded frames; if the frame rate here was guessed wrong (detection
  // can fail on a hidden page), take the engine's so frame i shows the frame it measured
  if (S.src && S.src.kind === 'video' && res.video && Math.abs(S.src.fps - res.video.fps) / res.video.fps > 0.02) {
    S.src.fps = Math.round(res.video.fps);
    const sel = $('fps');
    if (![...sel.options].some(o => +o.value === S.src.fps)) sel.add(new Option(`${S.src.fps} fps`, S.src.fps));
    sel.value = S.src.fps;
    $('fpsNote').textContent = `Frame rate set to ${S.src.fps} fps from the engine's reading of the video.`;
  }
  // seek by the engine's exact frame times, so variable-rate phone clips line up frame for frame
  if (S.src && S.src.kind === 'video' && res.times && res.times.length) S.src.times = Array.from({ length: res.first + res.times.length }, (_, i) => i < res.first ? null : res.times[i - res.first]);
  const fr = res.frames || [];
  res.points.forEach((p, j) => { if (p) S.points[res.first + j] = { x: p[0], y: p[1], score: fr[j] ? fr[j].score : 1, ...(p[2] ? { low: true } : {}) }; });
  (res.times || []).forEach((t, j) => { if (t != null) S.times[res.first + j] = t; });
  setRadius(res.plate.radiusPx);
  S.axisRatio = res.plate.axisRatio ?? S.axisRatio;
  setFacing(res.facing, true);
  S.pose = []; S.poseS = [];
  if (res.pose) {   // joints from the engine, in MediaPipe's 33-point layout: [x, y, z, visibility] × 33 per frame
    res.pose.frames.forEach((f, j) => {
      if (!f) return;
      const L = [];
      for (let k = 0; k < 33; k++) L.push({ x: f[k * 4], y: f[k * 4 + 1], z: f[k * 4 + 2], v: f[k * 4 + 3] });
      S.pose[res.pose.first + j] = L;
    });
    finishPose();
    $('poseMsg').textContent = `Body from the local engine (${res.pose.model}) on ${res.pose.frames.filter(Boolean).length} frames.`;
  }
  refreshTech();
}

$('btnEngine').onclick = runEngine;

export function refreshTech() {
  S.tech = S.points.some(Boolean) ? evaluate() : null;
  if (S.tech && S.tech.checks && !S.tech.checks.some(c => c.id === S.focus)) S.focus = null;
  renderTech();
}

const LABEL = { fault: 'Fault', watch: 'Watch', good: 'Good', info: 'Info', na: 'n/a' };
function renderTech() {
  const el = $('findings'), t = S.tech, count = $('techCount');
  count.textContent = '';
  if (!t) { el.innerHTML = '<p class="note">Nothing to check yet.</p>'; return; }
  if (t.error) { el.innerHTML = `<p class="note warn">${t.error}</p>`; return; }
  const n = s => t.checks.filter(c => c.status === s).length;
  if (n('fault')) count.textContent = n('fault');
  let html = `<div class="tally">
    <span class="pill fault">${n('fault')} fault${n('fault') === 1 ? '' : 's'}</span>
    <span class="pill watch">${n('watch')} to watch</span>
    <span class="pill good">${n('good')} good</span>
    ${n('na') ? `<span class="pill na">${n('na')} not checked</span>` : ''}</div>`;
  // what the verdicts were judged against
  const basis = [t.femurPx ? 'Body distances are judged against this lifter\'s thigh length.' : '',
    t.axisRatio != null ? (t.axisRatio < CONFIG.checks.mixedPlaneMinRatio
      ? `Camera ${Math.round((1 - t.axisRatio) * 100)} % off side-on (plate width ÷ height ${t.axisRatio.toFixed(2)}): bar distances corrected, bar-vs-body checks skipped.`
      : `Camera side-on (plate width ÷ height ${t.axisRatio.toFixed(2)}).`) : '',
    'The percentage on each finding is how far its inputs can be trusted.'].filter(Boolean).join(' ');
  html += `<p class="note">${basis}</p>`;
  for (const g of GROUPS) {
    const items = t.checks.filter(c => c.group === g);
    if (!items.length) continue;
    html += `<h3>${g}</h3><ul class="findings">` + items.map(c => `
      <li><button class="finding" data-id="${c.id}" aria-current="${c.id === S.focus}">
        <span class="pill ${c.status}">${LABEL[c.status]}</span>
        <span class="t">${c.title}</span>
        <span class="f">${c.frame == null ? '' : 'f ' + c.frame}${c.confidence != null && c.status !== 'info' ? ` · ${Math.round(c.confidence * 100)} %` : ''}</span>
        <span class="d">${c.text}</span>
      </button></li>`).join('') + '</ul>';
  }
  el.innerHTML = html;
}

$('findings').addEventListener('click', async e => {
  const b = e.target.closest('.finding'); if (!b || busy()) return;
  const c = S.tech.checks.find(x => x.id === b.dataset.id);
  S.focus = S.focus === c.id && S.frame === c.frame ? null : c.id;
  $('findings').querySelectorAll('.finding').forEach(x => x.setAttribute('aria-current', x.dataset.id === S.focus));
  if (S.playing) await pause();
  if (c.frame != null) await goto(c.frame); else render();
});

/* ---------- Drawing ---------- */

export function render() {
  const src = S.src; if (!src) return;
  if (S.compare) { drawCompareView(); return; }
  src.draw(vctx, view.width, view.height);
  drawOverlay();
  updateTransport();
}

/* ---------- Transport ---------- */


let wantFrame = null, seeking = false;
export async function goto(i) {
  if (!S.src) return;
  wantFrame = clamp(Math.round(i), 0, S.src.N - 1);
  if (seeking) return;
  seeking = true;
  while (wantFrame !== null) {
    const f = wantFrame; wantFrame = null;
    await S.src.seek(f); S.frame = f; render();
  }
  seeking = false;
  ui();
}

let playDone = null;
async function play(until) {
  const src = S.src, stop = Math.min(until ?? src.N - 1, src.N - 1);
  if (!src || S.tracking || S.analysing || S.playing) return;
  if (S.frame >= src.N - 1) await goto(0);
  S.playing = true; ui();
  const rate = +$('speed').value;
  const done = new Promise(r => { playDone = r; });
  if (src.kind === 'video') {
    const v = src.el;
    v.playbackRate = rate;
    try { await v.play(); } catch (e) { S.playing = false; ui(); playDone(); return done; }
    const loop = () => {
      if (!S.playing) return;
      S.frame = clamp(Math.floor(v.currentTime * src.fps + 1e-3), 0, src.N - 1);
      render();
      if (v.ended || S.frame >= stop) { pause(); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    const f0 = S.frame, t0 = performance.now();
    const loop = () => {
      if (!S.playing) return;
      const f = Math.min(src.N - 1, f0 + Math.floor((performance.now() - t0) / 1000 * src.fps * rate));
      if (f !== S.frame) { S.frame = f; src.seek(f); render(); }
      if (f >= stop) { pause(); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return done;
}

export async function pause() {
  if (!S.playing) return;
  S.playing = false;
  if (S.src.kind === 'video') S.src.el.pause();
  await goto(S.frame);
  if (playDone) { playDone(); playDone = null; }
}

function updateTransport() {
  const src = S.src; if (!src) return;
  const sc = $('scrub');
  sc.max = src.N - 1;
  if (!seeking || S.playing || S.tracking || S.analysing) sc.value = S.frame;
  $('counter').textContent = src.label ? `${src.label(S.frame)} · ${S.frame + 1}/${src.N}` : `f ${S.frame}/${src.N - 1} · ${(S.frame / src.fps).toFixed(2)} s`;
  if (S.tracking) $('chip').textContent = `Tracking the bar · frame ${S.frame} of ${src.N - 1}`;
  else if (S.analysing) $('chip').textContent = `Tracking the body · frame ${S.frame}`;
}

/* ---------- UI ---------- */

/* Tracking starts from the bar end clicked on this frame, or else from this frame's already-tracked position. */
function startPoint() {
  if (!S.src || S.src.kind === 'still') return null;
  if (S.anchor && S.anchor.frame === S.frame) return S.anchor;
  const p = S.points[S.frame];
  return p ? { x: p.x, y: p.y, frame: S.frame } : null;
}

export function setMsg(text, warn) { const m = $('trackMsg'); m.textContent = text; m.classList.toggle('warn', !!warn); }

export function ui() {
  const has = !!S.src, b = busy(), working = S.tracking || S.analysing;
  $('btnPlay').textContent = S.playing ? 'Pause' : 'Play';
  const still = has && S.src.kind === 'still';
  for (const id of ['btnPrev', 'btnNext', 'scrub']) $(id).disabled = !has || working || !!S.compare;
  for (const id of ['btnPlay', 'speed']) $(id).disabled = !has || working || !!S.compare || still;
  $('file').disabled = b; $('fps').disabled = b || !has || S.src.kind !== 'video';
  const start = startPoint();
  $('btnTrack').disabled = !start || b;
  $('btnFind').disabled = !has || b || S.src.kind !== 'video' || !!S.compare;
  $('btnEngine').disabled = !has || b || S.src.kind !== 'video' || !S.src.file || !S.engine || !S.engine.ok;
  $('btnEngine').textContent = S.engineBusy ? 'Engine working…' : S.engine && S.engine.models && !S.engine.models.ready ? 'High-quality analysis (local engine, loading models)' : 'High-quality analysis (local engine)';
  $('btnFind').textContent = S.finding ? 'Looking…' : `Find the plate on frame ${S.frame}`;
  $('btnTrack').textContent = has && S.src.kind !== 'still' ? `${start && !(S.anchor && S.anchor.frame === S.frame) ? 'Re-track' : 'Track'} from frame ${S.frame}` : 'Track';
  $('btnClear').disabled = !S.points.some(Boolean) || b;
  const earlier = start && S.points.slice(0, start.frame).some(Boolean);
  $('trackHint').textContent = !has || S.src.kind === 'still' ? '' :
    !start ? `Click the centre of the bar end on this frame (${S.frame}) to start tracking here.` :
    earlier ? `Frames before ${start.frame} keep their tracked path. Use Clear path to start the path here instead.` :
    `Tracking starts at frame ${start.frame} and runs to the end of the video. Press Stop to end early.`;
  $('btnStop').hidden = !S.tracking;
  $('stageStop').hidden = !working;
  $('stageLoad').hidden = b || !has || S.src.kind !== 'demo';
  $('stageTrack').hidden = !start || b || !!S.compare;
  $('stageTrack').textContent = $('btnTrack').textContent;
  const tracked = S.points.some(Boolean);
  const demo = has && S.src.kind === 'demo';   // its lifter is a drawn shape, which the body model can't see
  $('btnPose').disabled = !tracked || b || demo;
  $('btnPoseStop').hidden = !S.analysing;
  if (demo) { $('poseMsg').textContent = 'The sample clip has a drawn lifter, not a real one: choose your own video to track the body.'; $('poseMsg').classList.remove('warn'); }
  else if (!tracked) { $('poseMsg').textContent = 'Track the bar on the Bar path tab first.'; $('poseMsg').classList.remove('warn'); }
  else if (/^(Track the bar|The sample clip)/.test($('poseMsg').textContent)) $('poseMsg').textContent = 'Ready. This takes a few seconds per hundred frames.';
  $('btnPng').disabled = $('btnRec').disabled = !has || b;
  $('btnRec').textContent = S.recording ? 'Recording…' : 'Save video';
  $('screen').classList.toggle('busy', working);
  const chip = $('chip');
  chip.hidden = !!S.compare;
  if (has && !working) {
    chip.classList.remove('warn');
    chip.textContent = S.compare ? 'Comparing saved lifts' : still ? `Saved lift · ${S.src.name}` : `${S.src.name} · ${S.src.W}×${S.src.H} · ${S.src.fps} fps`;
  }
  $('hint').innerHTML = !has ? '' :
    S.compare ? 'Hover a path to read its height and drift. Pick lifts in the Library to add or remove them.' :
    still ? 'Saved without its video. Step through the saved positions with ‹ and ›.' :
    S.tracking ? 'Following the bar end frame by frame.' :
    S.analysing ? 'Finding the lifter on each frame.' :
    !S.anchor && !tracked ? 'Scrub to the start of the lift, then click the centre of the bar end and drag to the plate rim.' :
    !tracked ? 'Press <b>Track</b> in step 3.' :
    'Play to watch the path draw in. If the circle drifts off the bar, click the bar end on that frame and track again from there. <kbd>←</kbd> <kbd>→</kbd> step · <kbd>Space</kbd> play';
  if (!working) renderStats();
  libUi();
}

export function setSource(src) {
  exitCompare(true);
  if (S.src && S.src !== src && S.src.dispose) S.src.dispose();
  S.src = src; S.frame = 0; S.points = []; S.times = []; S.anchor = null; S.suggest = null; S.axisRatio = null;
  $('suggest').hidden = true; $('findMsg').textContent = '';
  S.recordId = null; S.viewing = null;
  S.pose = []; S.poseS = []; S.tech = null; S.focus = null;
  S.vk = Math.min(1, 1280 / Math.max(src.W, src.H));
  view.width = Math.round(src.W * S.vk); view.height = Math.round(src.H * S.vk);
  const rmax = Math.round(Math.min(src.W, src.H) / 3);
  $('radius').max = rmax;
  setRadius(src.R || clamp(Math.round(Math.min(src.W, src.H) * 0.08), 8, rmax));
  $('bar').style.width = '0'; $('poseBar').style.width = '0';
  renderTech();
  onSourceChange(src);
  renderLibrary();
}

export function setRadius(r) { S.radius = r; $('radius').value = r; $('radiusOut').textContent = `${Math.round(r)} px`; }

export function setFacing(f, quiet) {
  S.facing = f;
  $('faceL').setAttribute('aria-pressed', f < 0); $('faceR').setAttribute('aria-pressed', f > 0);
  if (!quiet) { refreshTech(); render(); ui(); }
}

export function setTab(t) {
  for (const [tab, panel, key] of [['tabPath', 'panelPath', 'path'], ['tabTech', 'panelTech', 'tech'], ['tabLib', 'panelLib', 'lib'], ['tabCoach', 'panelCoach', 'coach']]) {
    $(tab).setAttribute('aria-selected', t === key); $(panel).hidden = t !== key;
  }
}

export function setLift(l, quiet) {
  S.lift = l;
  $('liftSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.lift === l));
  if (!quiet) { refreshTech(); render(); ui(); }
}

async function loadFile(file) {
  if (!file || busy()) return;
  if (S.playing) await pause();
  const chip = $('chip');
  chip.classList.remove('warn');
  chip.textContent = `Opening ${file.name}…`;
  try {
    const src = await videoSource(file);
    setSource(src);
    const sel = $('fps');
    if (![...sel.options].some(o => +o.value === src.fps)) sel.add(new Option(`${src.fps} fps`, src.fps));
    sel.value = src.fps;
    $('fpsNote').textContent = src.detected
      ? `Detected ${src.detected} fps. Slow-motion phone clips often play back at 30; change it if the timing looks wrong.`
      : 'Could not detect the frame rate; set it to match your camera.';
    setMsg('Tracking runs frame by frame in your browser.');
    setTab('path');
    await goto(0);
    ui();
    await findPlate(true);
  } catch (e) {
    ui();
    chip.textContent = e.message; chip.classList.add('warn');
  }
}

function toSrc(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * view.width / S.vk, y: (e.clientY - r.top) / r.height * view.height / S.vk };
}

let drag = false;
view.addEventListener('pointerdown', async e => {
  if (!S.src || busy() || S.compare || S.src.kind === 'still') return;
  if (S.playing) await pause();
  const p = toSrc(e);
  S.anchor = { x: p.x, y: p.y, frame: S.frame };
  S.suggest = null; closeSuggestion();
  drag = true; view.setPointerCapture(e.pointerId);
  render(); ui();
});
view.addEventListener('pointermove', e => {
  if (!drag || !S.anchor) return;
  const p = toSrc(e), d = Math.hypot(p.x - S.anchor.x, p.y - S.anchor.y);
  if (d > 6 / S.vk) { setRadius(clamp(d, 8, +$('radius').max)); render(); }
});
const endDrag = () => { if (drag) { drag = false; refreshTech(); ui(); } };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

$('file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
const screen = $('screen');
screen.addEventListener('dragover', e => { e.preventDefault(); $('drop').hidden = false; });
screen.addEventListener('dragleave', e => { if (!screen.contains(e.relatedTarget)) $('drop').hidden = true; });
screen.addEventListener('drop', e => { e.preventDefault(); $('drop').hidden = true; loadFile(e.dataTransfer.files[0]); });

$('btnPlay').onclick = () => S.playing ? pause() : play();
$('btnPrev').onclick = async () => { if (S.playing) await pause(); goto(S.frame - 1); };
$('btnNext').onclick = async () => { if (S.playing) await pause(); goto(S.frame + 1); };
$('scrub').addEventListener('input', async e => { if (S.playing) await pause(); goto(+e.target.value); });
$('btnTrack').onclick = track;
$('btnClear').onclick = async () => {
  if (busy()) return;
  if (S.playing) await pause();
  S.points = []; S.times = []; S.pose = []; S.poseS = [];
  $('bar').style.width = '0'; $('poseBar').style.width = '0';
  setMsg('Path cleared. Go to the frame where the lift starts and click the bar end.');
  refreshTech(); render(); ui();
};
$('btnStop').onclick = () => { S.stop = true; };
$('stageStop').onclick = () => { S.stop = true; S.poseStop = true; };
$('stageTrack').onclick = track;
$('btnPose').onclick = runPose;
$('btnPoseStop').onclick = () => { S.poseStop = true; };
$('tabPath').onclick = () => setTab('path');
$('tabTech').onclick = () => setTab('tech');
$('tabLib').onclick = () => setTab('lib');
$('tabCoach').onclick = () => setTab('coach');
$('fps').addEventListener('change', async e => {
  if (!S.src || S.src.kind !== 'video') return;
  S.src.fps = +e.target.value; S.src.times = null; S.points = []; S.times = []; S.anchor = null; S.pose = []; S.poseS = [];
  setMsg('Frame rate changed. Mark the bar end again.');
  closeSuggestion(); refreshTech();   // the old suggestion's frame numbers no longer apply
  await goto(0); ui();
  await findPlate(true);
});
$('liftSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) setLift(b.dataset.lift);
});
$('radius').addEventListener('input', e => { setRadius(+e.target.value); render(); });
$('radius').addEventListener('change', () => { refreshTech(); ui(); });
$('scaleOn').addEventListener('change', e => { S.scaleOn = e.target.checked; ui(); });
for (const id of ['plumb', 'grow', 'descent']) $(id).addEventListener('change', e => { S[id] = e.target.checked; render(); });
$('smooth').addEventListener('change', e => { S.smooth = e.target.checked; refreshTech(); render(); ui(); });
$('showBody').addEventListener('change', e => { S.showBody = e.target.checked; render(); });
$('lw').addEventListener('input', e => { S.lw = +e.target.value; $('lwOut').textContent = `${S.lw} px`; render(); });
$('faceL').onclick = () => setFacing(-1);
$('faceR').onclick = () => setFacing(1);

const sw = $('swatches');
PLATES.forEach((p, i) => {
  const b = document.createElement('button');
  b.className = 'swatch'; b.style.background = p.color; b.title = p.name;
  b.setAttribute('aria-label', p.name); b.setAttribute('aria-pressed', i === 0);
  b.onclick = () => { S.color = p.color; sw.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-pressed', x === b)); render(); };
  sw.appendChild(b);
});

document.addEventListener('keydown', e => {
  if (!S.src || S.tracking || S.analysing || S.compare || e.target.closest('input, select, textarea')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); $('btnPrev').click(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); $('btnNext').click(); }
  else if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); $('btnPlay').click(); }
});
window.addEventListener('resize', () => { if (!S.playing && !S.tracking && !S.analysing) render(); });

/* ---------- Export ---------- */

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const baseName = () => (S.src.name || 'lift').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-');
$('btnPng').onclick = () => view.toBlob(b => b && download(b, `${baseName()}-bar-path.png`), 'image/png');
$('btnRec').onclick = async () => {
  if (!S.src || !window.MediaRecorder || !view.captureStream) { $('exportNote').textContent = 'This browser cannot record the canvas.'; return; }
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(view.captureStream(Math.min(60, S.src.fps)), { mimeType: type, videoBitsPerSecond: 8e6 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });
  S.recording = true; ui();
  const a = analyse(pathPoints()), first = a ? a.begin : S.points.findIndex(Boolean);
  await goto(Math.max(0, first));
  rec.start();
  await play(a ? a.end : undefined);   // the lift only
  rec.stop(); await stopped;
  S.recording = false; ui();
  download(new Blob(chunks, { type: rec.mimeType }), `${baseName()}-bar-path.${rec.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
};
$('exportNote').textContent = 'Save video replays the lift at the chosen speed and records it.';

/* ---------- Start with the sample ---------- */

refreshLibrary();
checkEngine();

(async () => {
  const demo = demoSource();
  setSource(demo);
  S.anchor = { x: demo.start.x, y: demo.start.y, frame: 0 };
  await goto(0);
  ui();
  await track();
  S.anchor = null;
  await goto(demo.N - 1);
})();
