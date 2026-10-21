/* Runs the app's own tracker on a generated clip and scores it against the clip's truth file.
   In the browser console on the running app:
     const { evalSample } = await import('/tests/eval-sample.js');
     await evalSample('snatch60')
   The start mark is placed exactly on the true bar centre with the true radius, so the numbers measure the
   tracker and the analysis, not how well someone clicks. Velocity comes from the app's smoother. */
import { $, S } from '../js/state.js';
import { videoSource } from '../js/sources.js';
import { score } from './score.js';
import { goto, setFacing, setLift, setRadius, setSource, ui } from '../js/app.js';

const until = async f => { while (!f()) await new Promise(r => setTimeout(r, 100)); };

export async function evalSample(name) {
  const truth = await (await fetch(`/samples/${name}.truth.json`)).json();
  const blob = await (await fetch(`/samples/${name}.mp4`)).blob();
  await until(() => !S.tracking);
  setSource(await videoSource(new File([blob], `${name}.mp4`, { type: 'video/mp4' })));
  setLift(truth.lift, true); setFacing(truth.facing, true); setRadius(truth.plateRadiusPx);
  await goto(truth.start.frame);
  S.anchor = { x: truth.start.x, y: truth.start.y, frame: truth.start.frame };
  ui();
  const t0 = performance.now();
  $('btnTrack').click();
  await until(() => S.tracking); await until(() => !S.tracking);
  const secs = (performance.now() - t0) / 1000;
  S.anchor = null;

  return { name, detectedFps: S.src.fps, trueFps: truth.fps, message: $('trackMsg').textContent, trackSeconds: +secs.toFixed(1), ...score(truth) };
}
