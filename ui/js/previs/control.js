// Control frames for video models: the shot drawn as depth, at the model's
// frame rate and size, packed into one animated PNG. Rendered frame by frame,
// so timing is exact and it does not depend on real-time recording.
import { sampleActor, sampleCamera, clamp } from './model.js';

export const CONTROL_FPS = 16;
const MAX_FRAMES = 81, MIN_FRAMES = 17;
const SIZES = { '16:9': [832, 480], '9:16': [480, 832], '1:1': [624, 624], '4:3': [640, 480] };

export const controlSize = (scene) => SIZES[scene.aspect] ?? SIZES['16:9'];

/** Video models want 4n+1 frames. Short shots hold their last pose to reach the minimum. */
export function controlFrames(scene) {
  const n = Math.floor((Math.min(scene.duration, (MAX_FRAMES - 1) / CONTROL_FPS) * CONTROL_FPS) / 4) * 4 + 1;
  return clamp(n, MIN_FRAMES, MAX_FRAMES);
}

/** Distance that maps to white: a little closer than the nearest actor ever gets to the camera. */
export function depthNear(scene, frames) {
  let nearest = Infinity;
  for (let i = 0; i < frames; i += 2) {
    const t = Math.min(i / CONTROL_FPS, scene.duration), cam = sampleCamera(scene, t);
    const points = scene.actors.map((a) => { const s = sampleActor(a, t); return [s.x, a.height / 2, s.z]; });
    if (!points.length) points.push(cam.target);
    for (const p of points) nearest = Math.min(nearest, Math.hypot(p[0] - cam.pos[0], p[1] - cam.pos[1], p[2] - cam.pos[2]));
  }
  return clamp(nearest * 0.85, 0.3, 60);
}

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

function readPng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) throw new Error('frame is not a PNG');
  const png = { ihdr: null, data: [] };
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') png.ihdr = body;
    else if (type === 'IDAT') png.data.push(body);
    at += 12 + size;
  }
  if (!png.ihdr || !png.data.length) throw new Error('frame PNG is incomplete');
  return png;
}

/** Joins same-size PNG files into one animated PNG that plays at `fps`. */
export function animatedPng(files, fps) {
  const frames = files.map(readPng), first = frames[0].ihdr;
  const u32 = (...values) => { const b = new Uint8Array(values.length * 4), v = new DataView(b.buffer); values.forEach((x, i) => v.setUint32(i * 4, x)); return b; };
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', first), chunk('acTL', u32(frames.length, 0))];
  const size = new DataView(first.buffer, first.byteOffset, 8);
  let seq = 0;
  frames.forEach((f, i) => {
    if (f.ihdr.length !== first.length || f.ihdr.some((b, k) => b !== first[k])) throw new Error('frames differ in size or format');
    const control = new Uint8Array(26), v = new DataView(control.buffer);
    v.setUint32(0, seq++);
    v.setUint32(4, size.getUint32(0));
    v.setUint32(8, size.getUint32(4));
    v.setUint16(20, 1);
    v.setUint16(22, fps);
    parts.push(chunk('fcTL', control));
    for (const d of f.data) {
      if (i === 0) { parts.push(chunk('IDAT', d)); continue; }
      const body = new Uint8Array(4 + d.length);
      new DataView(body.buffer).setUint32(0, seq++);
      body.set(d, 4);
      parts.push(chunk('fdAT', body));
    }
  });
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

/** Renders the whole shot as depth frames. `tick(done, total)` may return false to cancel. */
export async function renderControl(stage, scene, tick = () => true) {
  const frames = controlFrames(scene), [w, h] = controlSize(scene), near = depthNear(scene, frames);
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const src = stage.canvas, scale = Math.max(w / src.width, h / src.height);
  const dw = src.width * scale, dh = src.height * scale;
  const files = [];
  for (let i = 0; i < frames; i++) {
    stage.render(scene, Math.min(i / CONTROL_FPS, scene.duration), { grid: false, depthNear: near });
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const blob = await new Promise((resolve) => small.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not read a frame');
    files.push(new Uint8Array(await blob.arrayBuffer()));
    if ((await tick(i + 1, frames)) === false) return null;
  }
  return { blob: animatedPng(files, CONTROL_FPS), frames, width: w, height: h };
}
