// Talks to the Rust backend inside the app; falls back to a simulated
// backend when the UI is opened in a plain browser for design preview.
const T = window.__TAURI__;
export const native = !!T;

let mock;
async function getMock() {
  mock ??= await import('./mock.js');
  return mock;
}

export async function invoke(cmd, args = {}) {
  if (native) return T.core.invoke(cmd, args);
  return (await getMock()).invoke(cmd, args);
}

export async function listen(name, cb) {
  if (native) return T.event.listen(name, (e) => cb(e.payload));
  return (await getMock()).listen(name, cb);
}

export function fileSrc(path) {
  return native ? T.core.convertFileSrc(path) : path;
}
