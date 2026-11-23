// Turns a previs scene into a prompt draft: who is in the shot, how the camera
// moves and what each character does, in screen terms a video model understands.
import { sampleActor, sampleCamera, cameraFrame, aspectRatio, deg } from './model.js';

const W = {
  en: {
    sizes: { close: 'close-up', medium: 'medium shot', full: 'full shot', wide: 'wide shot' },
    angles: { top: 'top-down view', high: 'high angle', low: 'low angle', eye: 'eye level' },
    cam: {
      static: 'the camera holds still', push: 'the camera pushes in', pull: 'the camera pulls back',
      truckL: 'the camera tracks left', truckR: 'the camera tracks right', orbitL: 'the camera orbits to the left', orbitR: 'the camera orbits to the right',
      up: 'the camera cranes up', down: 'the camera cranes down', panL: 'the camera pans left', panR: 'the camera pans right',
      tiltU: 'the camera tilts up', tiltD: 'the camera tilts down', zoomIn: 'the lens zooms in', zoomOut: 'the lens zooms out',
    },
    follow: (n) => `, following ${n}`,
    slow: 'slowly ', fast: 'quickly ',
    gait: { walk: 'walks', run: 'runs' },
    dir: { lr: '{v} from left to right', rl: '{v} from right to left', toward: '{v} toward the camera', away: '{v} away from the camera' },
    place: { left: 'on the left of frame', center: 'in the centre of frame', right: 'on the right of frame', off: 'out of frame' },
    pose: { stand: 'stands', sit: 'sits', crouch: 'crouches', wave: 'waves', point: 'points ahead', cheer: 'raises both arms', lie: 'lies on the ground' },
    turns: 'turns', turnsBack: 'turns around', sep: ' ', enters: 'entering the frame', exits: 'leaving the frame',
    span: (a, b) => `${a}–${b}s`, anon: (i) => `Person ${i + 1}`, join: ', ', stop: '. ', colon: ': ',
    heads: { setting: 'Setting', cast: 'Characters', shot: 'Camera', action: 'Action', style: 'Style' },
    actLine: (who, what) => `${who} ${what}`,
  },
  zh: {
    sizes: { close: '特寫', medium: '中景', full: '全身鏡頭', wide: '遠景' },
    angles: { top: '俯視', high: '高角度', low: '低角度', eye: '平視' },
    cam: {
      static: '鏡頭固定', push: '鏡頭推近', pull: '鏡頭拉遠',
      truckL: '鏡頭向左橫移', truckR: '鏡頭向右橫移', orbitL: '鏡頭向左環繞', orbitR: '鏡頭向右環繞',
      up: '鏡頭升高', down: '鏡頭降低', panL: '鏡頭向左搖', panR: '鏡頭向右搖',
      tiltU: '鏡頭向上搖', tiltD: '鏡頭向下搖', zoomIn: '鏡頭變焦拉近', zoomOut: '鏡頭變焦拉遠',
    },
    follow: (n) => `，跟隨${n}`,
    slow: '緩慢地', fast: '快速地',
    gait: { walk: '走', run: '跑' },
    dir: { lr: '由畫面左方{v}到右方', rl: '由畫面右方{v}到左方', toward: '朝鏡頭{v}來', away: '背向鏡頭{v}遠' },
    place: { left: '在畫面左方', center: '在畫面中央', right: '在畫面右方', off: '在畫面外' },
    pose: { stand: '站立', sit: '坐下', crouch: '蹲下', wave: '揮手', point: '向前指', cheer: '舉起雙手', lie: '躺在地上' },
    turns: '轉向', turnsBack: '轉身', sep: '', enters: '進入畫面', exits: '離開畫面',
    span: (a, b) => `${a}–${b}秒`, anon: (i) => `人物${i + 1}`, join: '，', stop: '。', colon: '：',
    heads: { setting: '場景', cast: '角色', shot: '鏡頭', action: '動作', style: '風格' },
    actLine: (who, what) => `${who}${what}`,
  },
};

const fmt = (t) => (Math.round(t * 10) / 10).toFixed(1);
const nameOf = (scene, actor, w) => actor.name.trim() || w.anon(scene.actors.indexOf(actor));

/** Shot size and angle at time t, judged on the followed actor or the largest one in frame. */
export function shotAt(scene, t) {
  const cam = sampleCamera(scene, t), frame = cameraFrame(cam, aspectRatio(scene));
  let best = null;
  for (const a of scene.actors) {
    const s = sampleActor(a, t);
    const p = frame.project([s.x, a.height * 0.6, s.z]);
    if (!p.visible && a.id !== cam.followed) continue;
    const fill = a.height / frame.frameHeightAt(Math.max(p.depth, 0.1));
    if (a.id === cam.followed) { best = fill; break; }
    if (best == null || fill > best) best = fill;
  }
  const size = best == null ? 'wide' : best > 1.9 ? 'close' : best > 0.95 ? 'medium' : best > 0.33 ? 'full' : 'wide';
  const pitch = frame.forward[1];
  const angle = pitch < -0.85 ? 'top' : pitch < -0.33 ? 'high' : pitch > 0.2 ? 'low' : 'eye';
  return { size, angle };
}

/** Names the dominant camera move between two times. */
export function cameraMove(scene, t0, t1) {
  const a = sampleCamera(scene, t0), b = sampleCamera(scene, t1);
  const fa = cameraFrame(a, 1);
  const d = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
  const dist = Math.hypot(...d);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const yaw = (c) => Math.atan2(c.target[0] - c.pos[0], c.target[2] - c.pos[2]);
  const pitch = (c) => Math.atan2(c.target[1] - c.pos[1], Math.hypot(c.target[0] - c.pos[0], c.target[2] - c.pos[2]));
  let dyaw = yaw(b) - yaw(a);
  if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
  if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
  const dpitch = pitch(b) - pitch(a);
  const speed = dist / Math.max(t1 - t0, 0.1);

  let move = 'static';
  if (dist < 0.2) {
    // Seen from above, turning toward +yaw swings the view to the camera's left.
    if (Math.abs(deg(dyaw)) > 6 && Math.abs(dyaw) >= Math.abs(dpitch)) move = dyaw > 0 ? 'panL' : 'panR';
    else if (Math.abs(deg(dpitch)) > 6) move = dpitch > 0 ? 'tiltU' : 'tiltD';
    else if (Math.abs(b.fov - a.fov) > 4) move = b.fov < a.fov ? 'zoomIn' : 'zoomOut';
  } else {
    const f = dot(d, [fa.forward[0], 0, fa.forward[2]].map((v) => v / (Math.hypot(fa.forward[0], fa.forward[2]) || 1)));
    const r = dot(d, fa.right), u = d[1];
    const m = Math.max(Math.abs(f), Math.abs(r), Math.abs(u));
    if (m === Math.abs(u)) move = u > 0 ? 'up' : 'down';
    else if (m === Math.abs(f)) move = f > 0 ? 'push' : 'pull';
    else {
      const targetShift = Math.hypot(b.target[0] - a.target[0], b.target[2] - a.target[2]);
      const orbit = targetShift < dist * 0.4 && Math.abs(deg(dyaw)) > 12;
      move = (orbit ? 'orbit' : 'truck') + (r > 0 ? 'R' : 'L');
    }
  }
  return { move, speed, followed: b.followed };
}

function actorBeat(scene, actor, t0, t1, w) {
  const mid = (t0 + t1) / 2;
  const s0 = sampleActor(actor, t0 + 1e-3), s1 = sampleActor(actor, t1 - 1e-3), sm = sampleActor(actor, mid);
  const aspect = aspectRatio(scene);
  const p0 = cameraFrame(sampleCamera(scene, t0), aspect).project([s0.x, actor.height * 0.6, s0.z]);
  const p1 = cameraFrame(sampleCamera(scene, t1), aspect).project([s1.x, actor.height * 0.6, s1.z]);
  const place = (p) => (!p.visible ? 'off' : p.sx < -0.33 ? 'left' : p.sx > 0.33 ? 'right' : 'center');

  if (sm.moving) {
    const frame = cameraFrame(sampleCamera(scene, mid), aspect);
    const a = frame.project([s0.x, 0, s0.z]), b = frame.project([s1.x, 0, s1.z]);
    const depth = b.depth - a.depth, side = b.side - a.side;
    const dir = Math.abs(depth) > Math.abs(side) ? (depth < 0 ? 'toward' : 'away') : side > 0 ? 'lr' : 'rl';
    const parts = [w.dir[dir].replace('{v}', w.gait[sm.run > 0.5 ? 'run' : 'walk'])];
    if (!p0.visible && p1.visible) parts.push(w.enters);
    if (p0.visible && !p1.visible) parts.push(w.exits);
    return parts.join(w.join);
  }
  let turn = s1.heading - s0.heading;
  turn = Math.abs(((turn + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const parts = [w === W.zh ? w.place[place(p1)] + w.pose[sm.pose] : `${w.pose[sm.pose]} ${w.place[place(p1)]}`];
  if (deg(turn) > 45) parts.unshift(deg(turn) > 120 ? w.turnsBack : w.turns);
  return parts.join(w.join);
}

/** Time cuts where anything changes: every key of every track, plus start and end. */
function cuts(scene, tracks) {
  const set = new Set([0, scene.duration]);
  for (const keys of tracks) for (const k of keys) if (k.t > 0 && k.t < scene.duration) set.add(Math.round(k.t * 100) / 100);
  return [...set].sort((a, b) => a - b);
}

function mergeBeats(beats) {
  const out = [];
  for (const b of beats) {
    const last = out[out.length - 1];
    if (last && last.text === b.text) last.t1 = b.t1;
    else out.push({ ...b });
  }
  return out;
}

export function describe(scene, lang = 'en') {
  const w = W[lang === 'zh' ? 'zh' : 'en'];
  const lines = [];
  const head = (k, text) => lines.push(`${w.heads[k]}${w.colon}${text}`);
  if (scene.setting.trim()) head('setting', scene.setting.trim());
  if (scene.actors.length) {
    head('cast', scene.actors.map((a) => nameOf(scene, a, w) + (a.about.trim() ? (w === W.zh ? `（${a.about.trim()}）` : ` (${a.about.trim()})`) : '')).join(w === W.zh ? '；' : '; '));
  }

  const camCuts = cuts(scene, [scene.camera.keys]);
  const camBeats = [];
  for (let i = 0; i < camCuts.length - 1; i++) {
    const [t0, t1] = [camCuts[i], camCuts[i + 1]];
    const shot = shotAt(scene, (t0 + t1) / 2), mv = cameraMove(scene, t0, t1);
    const pace = mv.move === 'static' ? '' : mv.speed < 0.6 ? w.slow : mv.speed > 2.5 ? w.fast : '';
    let moveText = w.cam[mv.move];
    if (pace) moveText = w === W.zh ? moveText.replace('鏡頭', `鏡頭${pace}`) : moveText.replace(/(the camera|the lens) /, `$1 ${pace}`);
    const who = mv.followed && scene.actors.find((a) => a.id === mv.followed);
    camBeats.push({ t0, t1, text: [w.sizes[shot.size], w.angles[shot.angle], moveText + (who ? w.follow(nameOf(scene, who, w)) : '')].join(w.join) });
  }
  const stamp = (b, many) => (many ? w.span(fmt(b.t0), fmt(b.t1)) + ' ' : '');
  const sentences = (list) => list.join(w.stop.trim() + w.sep).trim();
  const cam = mergeBeats(camBeats);
  head('shot', sentences(cam.map((b) => stamp(b, cam.length > 1) + b.text)));

  const acts = [];
  for (const a of scene.actors) {
    const cs = cuts(scene, [a.keys]);
    const beats = [];
    for (let i = 0; i < cs.length - 1; i++) beats.push({ t0: cs[i], t1: cs[i + 1], text: actorBeat(scene, a, cs[i], cs[i + 1], w) });
    const merged = mergeBeats(beats);
    for (const b of merged) acts.push({ ...b, line: stamp(b, merged.length > 1) + w.actLine(nameOf(scene, a, w), b.text) });
  }
  acts.sort((x, y) => x.t0 - y.t0);
  if (acts.length) head('action', sentences(acts.map((b) => b.line)));
  if (scene.style.trim()) head('style', scene.style.trim());
  return lines.map((l) => (/[.。]$/.test(l) ? l : l + w.stop.trim())).join('\n');
}
