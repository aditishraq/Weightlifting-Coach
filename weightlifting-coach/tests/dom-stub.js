// state.js and pose.js touch the DOM at import time; give them just enough to load under Node.
const el = () => ({ getContext: () => ({}), style: {} });
globalThis.document = { getElementById: el, createElement: el };
