// Previs scene data and time sampling. Pure functions, no DOM, so the same
// maths drives the map, the 3D view, the prompt draft and the tests.
//
// World: metres, x to the right on the map, z down the map, y up.
// Heading: radians, 0 faces +z, so direction = (sin h, cos h).

export const POSES = ['stand', 'sit', 'crouch', 'wave', 'point', 'cheer', 'lie'];
export const ASPECTS = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960], '4:3': [960, 720] };
export const FPS = [16, 24, 30];
export const PALETTE = ['#f97316', '#38bdf8', '#a3e635', '#f472b6', '#facc15', '#c084fc', '#2dd4bf', '#fb7185'];
export const STEP = 0.05;          // key times snap to this
const TURN = 0.3;                  // seconds to turn when the heading changes at a key
const POSE_BLEND = 0.4;            // seconds to move into a new pose
const GAIT_RAMP = 0.25;            // seconds to start or stop walking
const MOVE_EPS = 0.05;             // metres; shorter segments count as standing still

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, u) => a + (b - a) * u;
export const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
export const snap = (t) => Math.round(t / STEP) / Math.round(1 / STEP);
export const sameTime = (a, b) => Math.abs(a - b) < STEP / 2 + 1e-9;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;

export function lerpAngle(a, b, u) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * u;
}

let counter = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function newScene(name) {
  const scene = {
    version: 1, name, duration: 6, fps: 24, aspect: '16:9', setting: '', style: '',
    ground: '#6b7280', sky: '#cfd8e6',
    actors: [], props: [],
    camera: { follow: '', ease: 'smooth', keys: [{ t: 0, x: 0, y: 1.6, z: 7, tx: 0, ty: 1.1, tz: 0, fov: 40 }] },
  };
  return scene;
}

export function demoScene(name, actorName) {
  const s = newScene(name);
  const a = newActor(s, actorName);
  a.keys = [
    { t: 0, x: -3, z: 0.5, face: null, pose: 'stand' },
    { t: 3, x: 0.5, z: 0.5, face: 0, pose: 'stand' },
    { t: 3.6, x: 0.5, z: 0.5, face: 0, pose: 'wave' },
  ];
  s.props.push({ id: uid('p'), name: '', kind: 'box', x: 2.6, z: -1.2, w: 1.2, d: 1.2, h: 1, rot: 20, color: '#94a3b8' });
  s.camera.keys = [
    { t: 0, x: 0, y: 1.6, z: 8, tx: 0, ty: 1.1, tz: 0, fov: 40 },
    { t: 6, x: 0.6, y: 1.5, z: 4.6, tx: 0.5, ty: 1.2, tz: 0.5, fov: 40 },
  ];
  return s;
}

export function newActor(scene, name) {
  const n = scene.actors.length;
  const actor = {
    id: uid('a'), name, about: '', color: PALETTE[n % PALETTE.length], height: 1.7,
    keys: [{ t: 0, x: -1 + n * 1.1, z: 1 + (n % 2) * 0.8, face: 0, pose: 'stand' }],
  };
  scene.actors.push(actor);
  return actor;
}

export function newProp(scene, kind = 'box') {
  const prop = { id: uid('p'), name: '', kind, x: 1.5, z: -1.5, w: 1, d: 1, h: 1, rot: 0, color: '#94a3b8' };
  scene.props.push(prop);
  return prop;
}

/** Makes loaded data safe to use; throws on anything that is not a scene. */
export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.actors) || !raw.camera) throw new Error('not a previs scene');
  const num = (v, d, a = -1e4, b = 1e4) => (Number.isFinite(Number(v)) ? clamp(Number(v), a, b) : d);
  const str = (v, max = 400) => String(v ?? '').slice(0, max);
  const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const base = newScene(str(raw.name, 60));
  const duration = num(raw.duration, 6, 1, 60);
  const time = (v) => snap(num(v, 0, 0, duration));
  const sortKeys = (keys) => {
    keys.sort((a, b) => a.t - b.t);
    return keys.filter((k, i) => i === 0 || !sameTime(k.t, keys[i - 1].t));
  };
  const scene = {
    ...base, duration,
    fps: FPS.includes(Number(raw.fps)) ? Number(raw.fps) : 24,
    aspect: ASPECTS[raw.aspect] ? raw.aspect : '16:9',
    setting: str(raw.setting), style: str(raw.style),
    ground: color(raw.ground, base.ground), sky: color(raw.sky, base.sky),
    actors: raw.actors.slice(0, 12).map((a, i) => ({
      id: str(a.id, 40) || uid('a'), name: str(a.name, 40), about: str(a.about),
      color: color(a.color, PALETTE[i % PALETTE.length]), height: num(a.height, 1.7, 0.8, 2.3),
      keys: sortKeys((Array.isArray(a.keys) && a.keys.length ? a.keys : [{}]).slice(0, 200).map((k) => ({
        t: time(k.t), x: num(k.x, 0, -50, 50), z: num(k.z, 0, -50, 50),
        face: k.face == null ? null : num(k.face, 0, -360, 360),
        pose: POSES.includes(k.pose) ? k.pose : 'stand',
      }))),
    })),
    props: (Array.isArray(raw.props) ? raw.props : []).slice(0, 60).map((p) => ({
      id: str(p.id, 40) || uid('p'), name: str(p.name, 40), kind: p.kind === 'cylinder' ? 'cylinder' : 'box',
      x: num(p.x, 0, -50, 50), z: num(p.z, 0, -50, 50), w: num(p.w, 1, 0.1, 30), d: num(p.d, 1, 0.1, 30),
      h: num(p.h, 1, 0.05, 20), rot: num(p.rot, 0, -360, 360), color: color(p.color, '#94a3b8'),
    })),
  };
  const ck = Array.isArray(raw.camera.keys) && raw.camera.keys.length ? raw.camera.keys : base.camera.keys;
  scene.camera = {
    follow: scene.actors.some((a) => a.id === raw.camera.follow) ? raw.camera.follow : '',
    ease: raw.camera.ease === 'linear' ? 'linear' : 'smooth',
    keys: sortKeys(ck.slice(0, 200).map((k) => ({
      t: time(k.t), x: num(k.x, 0, -80, 80), y: num(k.y, 1.6, 0.1, 60), z: num(k.z, 7, -80, 80),
      tx: num(k.tx, 0, -80, 80), ty: num(k.ty, 1.1, 0, 40), tz: num(k.tz, 0, -80, 80), fov: num(k.fov, 40, 10, 100),
    }))),
  };
  return scene;
}

// ---------- keys ----------

export function keyIndexAt(keys, t) {
  return keys.findIndex((k) => sameTime(k.t, t));
}

function insertKey(keys, key) {
  const i = keyIndexAt(keys, key.t);
  if (i >= 0) { Object.assign(keys[i], key); return keys[i]; }
  keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return key;
}

/** Writes values into the actor's key at time t, creating it from the sampled state if needed. */
export function setActorKey(actor, t, patch = {}) {
  t = snap(t);
  const i = keyIndexAt(actor.keys, t);
  if (i >= 0) return Object.assign(actor.keys[i], patch);
  const s = sampleActor(actor, t);
  return insertKey(actor.keys, { t, x: s.x, z: s.z, face: null, pose: s.pose, ...patch });
}

export function setCameraKey(scene, t, patch = {}) {
  t = snap(t);
  const keys = scene.camera.keys;
  const i = keyIndexAt(keys, t);
  if (i >= 0) return Object.assign(keys[i], patch);
  return insertKey(keys, { t, ...rawCamera(scene.camera, t), ...patch });
}

/** Removes the key at t. A track always keeps at least one key. */
export function removeKey(keys, t) {
  const i = keyIndexAt(keys, t);
  if (i < 0 || keys.length < 2) return false;
  keys.splice(i, 1);
  return true;
}

/** Moves a key in time without letting it cross or land on a neighbour. */
export function retimeKey(keys, index, t, duration) {
  const lo = index > 0 ? keys[index - 1].t + STEP : 0;
  const hi = index < keys.length - 1 ? keys[index + 1].t - STEP : duration;
  keys[index].t = snap(clamp(t, lo, hi));
  return keys[index].t;
}

export function setDuration(scene, duration) {
  scene.duration = clamp(Math.round(duration), 1, 60);
  for (const keys of [scene.camera.keys, ...scene.actors.map((a) => a.keys)]) {
    const kept = keys.filter((k, i) => i === 0 || k.t <= scene.duration);
    keys.splice(0, keys.length, ...kept);
    keys[0].t = Math.min(keys[0].t, scene.duration);
  }
}

// ---------- sampling ----------

function segments(keys) {
  const segs = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz), dt = Math.max(b.t - a.t, 1e-6);
    const moving = dist > MOVE_EPS;
    segs.push({ dist: moving ? dist : 0, dt, moving, dir: Math.atan2(dx, dz), speed: moving ? dist / dt : 0 });
  }
  return segs;
}

function keyHeadings(keys, segs) {
  const firstMove = segs.find((s) => s.moving);
  const out = [];
  keys.forEach((k, i) => {
    if (k.face != null) out.push(rad(k.face));
    else if (i === 0) out.push(firstMove ? firstMove.dir : 0);
    else out.push(segs[i - 1].moving ? segs[i - 1].dir : out[i - 1]);
  });
  return out;
}

// Gait cycle length in metres (two steps), longer when running.
const runAmount = (speed) => clamp((speed - 2.2) / 1.5, 0, 1);
const cycleLength = (speed, height) => lerp(1.4, 2.9, runAmount(speed)) * (height / 1.7);

export function sampleActor(actor, t) {
  const keys = actor.keys, n = keys.length;
  const segs = segments(keys), heads = keyHeadings(keys, segs);
  const raw = (i, u) => (segs[i].moving ? segs[i].dir : lerpAngle(heads[i], heads[i + 1], smooth(u)));

  let i = 0;
  while (i < n - 1 && t >= keys[i + 1].t) i++;
  const before = t < keys[0].t, after = i === n - 1;
  const seg = after || before ? null : segs[i];
  const u = seg ? clamp((t - keys[i].t) / seg.dt, 0, 1) : 0;

  const a = keys[i], b = seg ? keys[i + 1] : a;
  const x = lerp(a.x, b.x, u), z = lerp(a.z, b.z, u);

  let heading;
  if (before) heading = heads[0];
  else {
    const target = seg ? raw(i, u) : heads[i];
    const prevEnd = i > 0 ? raw(i - 1, 1) : heads[0];
    heading = lerpAngle(prevEnd, target, smooth((t - a.t) / TURN));
  }

  let phase = 0;
  for (let j = 0; j < segs.length && j <= i; j++) {
    if (!segs[j].moving) continue;
    const part = j < i || after ? 1 : u;
    phase += ((segs[j].dist * part) / cycleLength(segs[j].speed, actor.height)) * 2 * Math.PI;
  }

  let gait = 0, speed = 0;
  if (seg?.moving) {
    speed = seg.speed;
    const fromRest = i === 0 || !segs[i - 1].moving, toRest = i === segs.length - 1 || !segs[i + 1].moving;
    gait = Math.min(1, fromRest ? (t - a.t) / GAIT_RAMP : 1, toRest ? (b.t - t) / GAIT_RAMP : 1);
  }

  const pose = a.pose, prevPose = i > 0 && !before ? keys[i - 1].pose : a.pose;
  const poseMix = before ? 1 : smooth((t - a.t) / POSE_BLEND);
  return { x, z, heading, phase, gait: clamp(gait, 0, 1), run: runAmount(speed), speed, moving: !!seg?.moving, pose, prevPose, poseMix, keyIndex: i };
}

function rawCamera(camera, t) {
  const keys = camera.keys;
  let i = 0;
  while (i < keys.length - 1 && t >= keys[i + 1].t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  let u = b === a ? 0 : clamp((t - a.t) / (b.t - a.t), 0, 1);
  if (camera.ease !== 'linear') u = smooth(u);
  const out = {};
  for (const f of ['x', 'y', 'z', 'tx', 'ty', 'tz', 'fov']) out[f] = lerp(a[f], b[f], u);
  return out;
}

export function sampleCamera(scene, t) {
  const c = rawCamera(scene.camera, t);
  const who = scene.camera.follow && scene.actors.find((a) => a.id === scene.camera.follow);
  if (who) {
    const s = sampleActor(who, t);
    c.tx = s.x; c.tz = s.z; c.ty = who.height * 0.72;
  }
  // Looking straight down breaks the view maths, so keep a sliver of horizontal offset.
  if (Math.hypot(c.tx - c.x, c.tz - c.z) < 0.02) c.tz -= 0.02;
  return { pos: [c.x, c.y, c.z], target: [c.tx, c.ty, c.tz], fov: c.fov, followed: who ? who.id : '' };
}

/** Camera axes and a projector into normalised screen space (-1..1, y up). */
export function cameraFrame(cam, aspect) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const forward = unit(sub(cam.target, cam.pos));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const tan = Math.tan(rad(cam.fov) / 2);
  return {
    forward, right, up,
    project(p) {
      const v = sub(p, cam.pos), depth = dot(v, forward);
      const sx = dot(v, right) / (Math.abs(depth) * tan * aspect || 1e-6);
      const sy = dot(v, up) / (Math.abs(depth) * tan || 1e-6);
      return { sx, sy, depth, side: dot(v, right), visible: depth > 0.1 && Math.abs(sx) <= 1 && Math.abs(sy) <= 1.2 };
    },
    frameHeightAt: (depth) => 2 * depth * tan,
  };
}

export function aspectRatio(scene) {
  const [w, h] = ASPECTS[scene.aspect];
  return w / h;
}
