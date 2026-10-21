/* Runs the bar tracker off the main thread. Messages: { id, type: 'init' | 'step' | 'finish', ... } → { id, r }. */
import { BarTracker } from './ncc.js';

let tk = null;
self.onmessage = ({ data: d }) => {
  let r = null;
  if (d.type === 'init') { tk = new BarTracker(d.cfg); r = tk.init(d.img, d.x, d.y, d.ts, d.radius); }
  else if (d.type === 'step') r = tk.step(d.img);
  else if (d.type === 'finish') r = tk.finish(d.roi);
  self.postMessage({ id: d.id, r });
};
