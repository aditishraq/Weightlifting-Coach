import { CONFIG } from './config.js';

/* ---------- Local engine client (engine/, docs/result-format.md). Only ever talks to CONFIG.engine.url. ---------- */

const url = path => CONFIG.engine.url.replace(/\/$/, '') + path;

/* The engine's /health reply, or null when it isn't running. */
export async function engineHealth() {
  try {
    const r = await fetch(url('/health'), { signal: AbortSignal.timeout(CONFIG.engine.healthMs) });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

/* Sends the video and waits for the result; onProgress(stage, 0..1). */
export async function engineAnalyze(file, { lift, facing, weightKg, hint }, onProgress) {
  const body = new FormData();
  body.append('video', file, file.name || 'lift.mp4');
  body.append('lift', lift); body.append('facing', String(facing));
  if (weightKg) body.append('weightKg', String(weightKg));
  if (hint) body.append('hint', JSON.stringify(hint));
  let r = await fetch(url('/analyze'), { method: 'POST', body, headers: { 'X-WL-Coach': '1' } });   // see engine/app.py
  if (!r.ok) throw new Error(`the engine refused the video (${r.status} ${await r.text()})`);
  const { job } = await r.json();
  for (;;) {
    await new Promise(res => setTimeout(res, CONFIG.engine.pollMs));
    r = await fetch(url(`/jobs/${job}`));
    if (!r.ok) throw new Error(`lost the engine job (${r.status})`);
    const j = await r.json();
    onProgress(j.stage, j.progress);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error);
  }
}
