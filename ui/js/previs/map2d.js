// Top-down blocking map: drag characters, props and the camera around the floor.
// Dragging a character or the camera writes a key at the current time.
import { sampleActor, sampleCamera, setActorKey, setCameraKey, aspectRatio, rad, clamp } from './model.js';

const GRAB = 14; // pixels

export class Map2D {
  /** host: { scene(), time(), selection(), select(sel), changed(), commit() } */
  constructor(canvas, host) {
    this.canvas = canvas;
    this.host = host;
    this.ctx = canvas.getContext('2d');
    this.scale = 34;          // pixels per metre
    this.center = { x: 0, z: 1.5 };
    this.drag = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  toScreen(x, z) {
    const { width, height } = this.canvas.getBoundingClientRect();
    return [width / 2 + (x - this.center.x) * this.scale, height / 2 + (z - this.center.z) * this.scale];
  }
  toWorld(px, py) {
    const { width, height } = this.canvas.getBoundingClientRect();
    return [this.center.x + (px - width / 2) / this.scale, this.center.z + (py - height / 2) / this.scale];
  }
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  hit(px, py) {
    const scene = this.host.scene(), t = this.host.time(), sel = this.host.selection();
    const near = (x, z, r = GRAB) => { const [sx, sy] = this.toScreen(x, z); return Math.hypot(sx - px, sy - py) <= r; };
    const cam = sampleCamera(scene, t);
    const camHit = !scene.camera.follow && near(cam.target[0], cam.target[2], 11) ? { type: 'camera', part: 'target' }
      : near(cam.pos[0], cam.pos[2], 15) ? { type: 'camera', part: 'body' } : null;
    let actorHit = null;
    for (const a of [...scene.actors].reverse()) {
      const s = sampleActor(a, t);
      if (near(s.x, s.z, Math.max(GRAB, 0.3 * this.scale))) { actorHit = { type: 'actor', id: a.id, part: 'now' }; break; }
    }
    // Where a person and the camera's aim overlap, the person wins unless the camera is selected.
    if (camHit && actorHit) return sel.type === 'camera' ? camHit : actorHit;
    if (camHit || actorHit) return camHit ?? actorHit;
    const chosen = sel.type === 'actor' && scene.actors.find((a) => a.id === sel.id);
    if (chosen) {
      const i = chosen.keys.findIndex((k) => near(k.x, k.z, 9));
      if (i >= 0) return { type: 'actor', id: chosen.id, part: 'key', index: i };
    }
    const [wx, wz] = this.toWorld(px, py);
    for (const p of [...scene.props].reverse()) {
      const c = Math.cos(rad(-p.rot)), s = Math.sin(rad(-p.rot));
      const lx = (wx - p.x) * c - (wz - p.z) * s, lz = (wx - p.x) * s + (wz - p.z) * c;
      const inside = p.kind === 'cylinder' ? (lx / (p.w / 2)) ** 2 + (lz / (p.d / 2)) ** 2 <= 1 : Math.abs(lx) <= p.w / 2 && Math.abs(lz) <= p.d / 2;
      if (inside) return { type: 'prop', id: p.id, part: 'body', dx: wx - p.x, dz: wz - p.z };
    }
    return null;
  }

  down(e) {
    const [px, py] = this.point(e);
    const h = this.hit(px, py);
    this.canvas.setPointerCapture(e.pointerId);
    if (!h) {
      this.drag = { pan: true, px, py, cx: this.center.x, cz: this.center.z, moved: false };
      return;
    }
    this.host.select({ type: h.type, id: h.id ?? '' });
    this.drag = { ...h, moved: false };
  }

  move(e) {
    const [px, py] = this.point(e);
    const d = this.drag;
    if (!d) {
      this.canvas.style.cursor = this.hit(px, py) ? 'grab' : 'default';
      return;
    }
    d.moved = true;
    if (d.pan) {
      this.center.x = d.cx - (px - d.px) / this.scale;
      this.center.z = d.cz - (py - d.py) / this.scale;
      return this.draw();
    }
    const scene = this.host.scene(), t = this.host.time();
    let [x, z] = this.toWorld(px, py);
    x = Math.round(clamp(x, -50, 50) * 20) / 20;
    z = Math.round(clamp(z, -50, 50) * 20) / 20;
    if (d.type === 'actor') {
      const actor = scene.actors.find((a) => a.id === d.id);
      if (d.part === 'key') Object.assign(actor.keys[d.index], { x, z });
      else setActorKey(actor, t, { x, z });
    } else if (d.type === 'camera') {
      setCameraKey(scene, t, d.part === 'target' ? { tx: x, tz: z } : { x, z });
    } else if (d.type === 'prop') {
      const prop = scene.props.find((p) => p.id === d.id);
      prop.x = Math.round((x - d.dx) * 20) / 20;
      prop.z = Math.round((z - d.dz) * 20) / 20;
    }
    this.host.changed();
  }

  up(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.pan && !d.moved) this.host.select({ type: 'scene', id: '' });
    if (!d.pan && d.moved) this.host.commit();
  }

  wheel(e) {
    e.preventDefault();
    const [px, py] = this.point(e);
    const before = this.toWorld(px, py);
    this.scale = clamp(this.scale * Math.exp(-e.deltaY * 0.0015), 8, 140);
    const after = this.toWorld(px, py);
    this.center.x += before[0] - after[0];
    this.center.z += before[1] - after[1];
    this.draw();
  }

  /** Fits the view around everything in the scene. */
  fit() {
    const scene = this.host.scene();
    const pts = [];
    for (const a of scene.actors) for (const k of a.keys) pts.push([k.x, k.z]);
    for (const k of scene.camera.keys) pts.push([k.x, k.z], [k.tx, k.tz]);
    for (const p of scene.props) pts.push([p.x - p.w / 2, p.z - p.d / 2], [p.x + p.w / 2, p.z + p.d / 2]);
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    const { width, height } = this.canvas.getBoundingClientRect();
    const w = Math.max(...xs) - Math.min(...xs) + 3, h = Math.max(...zs) - Math.min(...zs) + 3;
    this.center = { x: (Math.max(...xs) + Math.min(...xs)) / 2, z: (Math.max(...zs) + Math.min(...zs)) / 2 };
    this.scale = clamp(Math.min(width / w, height / h), 8, 140);
    this.draw();
  }

  draw() {
    const cv = this.canvas, ctx = this.ctx;
    const { width, height } = cv.getBoundingClientRect();
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#17141f';
    ctx.fillRect(0, 0, width, height);
    const scene = this.host.scene(), t = this.host.time(), sel = this.host.selection();
    if (!scene) return;

    // grid: 1 m lines, heavier every 5 m
    const [x0, z0] = this.toWorld(0, 0), [x1, z1] = this.toWorld(width, height);
    const line = (ax, az, bx, bz) => { const [a, b] = this.toScreen(ax, az), [c, d] = this.toScreen(bx, bz); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); };
    const step = this.scale < 16 ? 5 : 1;
    ctx.lineWidth = 1;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.strokeStyle = x % 5 === 0 ? '#453e5e' : '#2b2640'; line(x, z0, x, z1); }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) { ctx.strokeStyle = z % 5 === 0 ? '#453e5e' : '#2b2640'; line(x0, z, x1, z); }

    for (const p of scene.props) {
      const [sx, sy] = this.toScreen(p.x, p.z);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(rad(p.rot));
      ctx.fillStyle = p.color + 'aa';
      ctx.strokeStyle = sel.type === 'prop' && sel.id === p.id ? '#fff' : p.color;
      ctx.lineWidth = sel.type === 'prop' && sel.id === p.id ? 2 : 1;
      ctx.beginPath();
      if (p.kind === 'cylinder') ctx.ellipse(0, 0, (p.w / 2) * this.scale, (p.d / 2) * this.scale, 0, 0, Math.PI * 2);
      else ctx.rect((-p.w / 2) * this.scale, (-p.d / 2) * this.scale, p.w * this.scale, p.d * this.scale);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (p.name) this.label(p.name, sx, sy + 4, '#e5e7eb');
    }

    // camera path, view wedge, body and target
    const cam = sampleCamera(scene, t), camSel = sel.type === 'camera';
    const keys = scene.camera.keys;
    if (keys.length > 1) {
      ctx.strokeStyle = '#fde68a88';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      keys.forEach((k, i) => { const [a, b] = this.toScreen(k.x, k.z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fde68a';
      for (const k of keys) { const [a, b] = this.toScreen(k.x, k.z); ctx.fillRect(a - 2.5, b - 2.5, 5, 5); }
    }
    const [cx, cy] = this.toScreen(cam.pos[0], cam.pos[2]), [tx, ty] = this.toScreen(cam.target[0], cam.target[2]);
    const yaw = Math.atan2(ty - cy, tx - cx);
    const half = Math.atan(Math.tan(rad(cam.fov) / 2) * aspectRatio(scene));
    const reach = Math.max(Math.hypot(tx - cx, ty - cy) * 1.25, 60);
    ctx.fillStyle = '#fde68a14';
    ctx.strokeStyle = '#fde68a66';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(yaw - half) * reach, cy + Math.sin(yaw - half) * reach);
    ctx.lineTo(cx + Math.cos(yaw + half) * reach, cy + Math.sin(yaw + half) * reach);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw);
    ctx.fillStyle = '#fde68a';
    ctx.strokeStyle = camSel ? '#fff' : '#92711a';
    ctx.lineWidth = camSel ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(-11, -7, 16, 14, 3);
    ctx.moveTo(5, -3); ctx.lineTo(12, -7); ctx.lineTo(12, 7); ctx.lineTo(5, 3);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (!scene.camera.follow) {
      ctx.strokeStyle = '#fde68a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.moveTo(tx - 9, ty); ctx.lineTo(tx + 9, ty); ctx.moveTo(tx, ty - 9); ctx.lineTo(tx, ty + 9);
      ctx.stroke();
    }

    for (const a of scene.actors) {
      const chosen = sel.type === 'actor' && sel.id === a.id;
      if (a.keys.length > 1) {
        ctx.strokeStyle = a.color + (chosen ? 'ff' : '88');
        ctx.lineWidth = chosen ? 2 : 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        a.keys.forEach((k, i) => { const [x, y] = this.toScreen(k.x, k.z); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
        ctx.setLineDash([]);
        for (const k of a.keys) {
          const [x, y] = this.toScreen(k.x, k.z);
          ctx.fillStyle = chosen ? '#fff' : a.color;
          ctx.beginPath();
          ctx.arc(x, y, chosen ? 4 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const s = sampleActor(a, t), [x, y] = this.toScreen(s.x, s.z), r = Math.max(0.24 * this.scale, 7);
      // heading on screen: world direction (sin h, cos h) maps to screen (x, y)
      const hx = Math.sin(s.heading), hy = Math.cos(s.heading);
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(x + hx * r * 1.9, y + hy * r * 1.9);
      ctx.lineTo(x - hy * r * 0.75, y + hx * r * 0.75);
      ctx.lineTo(x + hy * r * 0.75, y - hx * r * 0.75);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = chosen ? '#fff' : '#00000066';
      ctx.lineWidth = chosen ? 2.5 : 1;
      ctx.stroke();
      this.label(a.name || '?', x, y + r + 13, '#fff');
    }

    // 1 m scale bar
    ctx.strokeStyle = ctx.fillStyle = '#a29cb8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, height - 12); ctx.lineTo(12 + this.scale * step, height - 12);
    ctx.stroke();
    ctx.font = '11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${step} m`, 12, height - 18);
  }

  label(text, x, y, color) {
    const ctx = this.ctx;
    ctx.font = '600 11px -apple-system, "PingFang HK", sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#17141fcc';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
}
