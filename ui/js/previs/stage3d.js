// The 3D view of a previs scene: ground, props and jointed mannequins,
// drawn through the scene camera at any point in time.
import * as THREE from '../../vendor/three.module.min.js';
import { sampleActor, sampleCamera, ASPECTS, lerp, rad } from './model.js';

// Joint angles in radians. Legs and arms hang down at 0; negative x swings a limb forward.
// hip: pelvis height offset as a fraction of body height. flat: 1 lays the body on its back.
const REST = { hip: 0, lean: 0, head: 0, flat: 0, lArmX: 0, lArmZ: 0.1, rArmX: 0, rArmZ: -0.1, lElbow: -0.12, rElbow: -0.12, lLeg: 0, rLeg: 0, lKnee: 0, rKnee: 0 };
const POSE = {
  stand: {},
  sit: { hip: -0.25, lean: 0.06, lLeg: -1.5, rLeg: -1.5, lKnee: 1.5, rKnee: 1.5, lArmX: -0.5, rArmX: -0.5, lElbow: -0.7, rElbow: -0.7 },
  crouch: { hip: -0.36, lean: 0.55, head: -0.3, lLeg: -2.0, rLeg: -2.0, lKnee: 2.4, rKnee: 2.4, lArmX: -1.0, rArmX: -1.0, lElbow: -0.5, rElbow: -0.5 },
  wave: { rArmZ: -2.5, rElbow: -0.5 },
  point: { rArmX: -1.5, rArmZ: -0.05, rElbow: 0, lean: 0.05 },
  cheer: { lArmX: -2.9, rArmX: -2.9, lArmZ: 0.35, rArmZ: -0.35, lElbow: -0.15, rElbow: -0.15, head: -0.15 },
  lie: { hip: -0.45, flat: 1, lArmZ: 0.5, rArmZ: -0.5 },
};
const JOINTS = Object.keys(REST);
const poseOf = (name) => ({ ...REST, ...POSE[name] });

/** Final joint angles for one actor sample: held pose, blended into a walk or run cycle. */
export function jointAngles(s, time) {
  const a = poseOf(s.prevPose), b = poseOf(s.pose), out = {};
  for (const j of JOINTS) out[j] = lerp(a[j], b[j], s.poseMix);
  const live = (name) => (s.pose === name ? s.poseMix : 0) + (s.prevPose === name ? 1 - s.poseMix : 0);
  out.rElbow += live('wave') * 0.45 * Math.sin(time * 7);
  const hop = live('cheer') * Math.abs(Math.sin(time * 6));
  out.hip += hop * 0.02;

  if (s.gait > 0) {
    const r = s.run, p = s.phase, swing = lerp(0.5, 0.95, r), bend = lerp(0.9, 1.7, r);
    const walk = {
      ...REST,
      hip: (-0.008 + 0.01 * Math.cos(2 * p)) * (1 + r), lean: lerp(0.05, 0.28, r),
      lLeg: -Math.sin(p) * swing, rLeg: Math.sin(p) * swing,
      lKnee: bend * Math.max(0, Math.cos(p)), rKnee: bend * Math.max(0, -Math.cos(p)),
      lArmX: Math.sin(p) * swing * 0.75, rArmX: -Math.sin(p) * swing * 0.75,
      lElbow: -lerp(0.25, 1.3, r), rElbow: -lerp(0.25, 1.3, r),
    };
    for (const j of JOINTS) out[j] = lerp(out[j], walk[j], s.gait);
  }
  return out;
}

function limb(radius, length, material) {
  const geo = new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.001), 4, 12);
  geo.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

// Proportions as fractions of total height.
const P = { thigh: 0.245, shin: 0.245, foot: 0.03, torso: 0.3, upperArm: 0.16, foreArm: 0.15, head: 0.075, hipW: 0.055, shoulderW: 0.115 };
const HIP_Y = P.thigh + P.shin + P.foot;

function buildFigure(color, H) {
  const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.8 });
  const root = new THREE.Group();
  const hips = new THREE.Group();
  root.add(hips);
  const j = { root, hips };

  const torso = new THREE.Group();
  hips.add(torso);
  const body = limb(0.085 * H, (P.torso + 0.06) * H, skin);
  body.position.y = P.torso * H;
  body.scale.set(1.25, 1, 0.8);
  torso.add(body);
  j.torso = torso;

  const head = new THREE.Group();
  head.position.y = (P.torso + 0.03) * H;
  torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(P.head * H, 20, 14), skin);
  skull.position.y = P.head * H;
  skull.castShadow = true;
  // A dark visor marks the front of the head so facing reads at a glance.
  const visor = new THREE.Mesh(new THREE.BoxGeometry(P.head * 1.3 * H, P.head * 0.45 * H, P.head * 0.5 * H), dark);
  visor.position.set(0, P.head * 1.1 * H, P.head * 0.78 * H);
  head.add(skull, visor);
  j.head = head;

  for (const [side, sign] of [['l', 1], ['r', -1]]) {
    const arm = new THREE.Group();
    arm.position.set(sign * P.shoulderW * H, (P.torso - 0.035) * H, 0);
    arm.add(limb(0.032 * H, P.upperArm * H, skin));
    const elbow = new THREE.Group();
    elbow.position.y = -P.upperArm * H;
    elbow.add(limb(0.028 * H, P.foreArm * H, skin));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.033 * H, 12, 10), dark);
    hand.position.y = -P.foreArm * H;
    hand.castShadow = true;
    elbow.add(hand);
    arm.add(elbow);
    torso.add(arm);

    const leg = new THREE.Group();
    leg.position.set(sign * P.hipW * H, 0, 0);
    leg.add(limb(0.047 * H, P.thigh * H, skin));
    const knee = new THREE.Group();
    knee.position.y = -P.thigh * H;
    knee.add(limb(0.038 * H, P.shin * H, skin));
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.055 * H, P.foot * H, 0.13 * H), dark);
    foot.position.set(0, -(P.shin + P.foot / 2) * H, 0.035 * H);
    foot.castShadow = true;
    knee.add(foot);
    leg.add(knee);
    hips.add(leg);
    Object.assign(j, { [side + 'Arm']: arm, [side + 'Elbow']: elbow, [side + 'Leg']: leg, [side + 'Knee']: knee });
  }
  root.userData = { joints: j, H };
  return root;
}

function applyPose(figure, s, time) {
  const { joints: j, H } = figure.userData, a = jointAngles(s, time);
  figure.position.set(s.x, 0, s.z);
  figure.rotation.y = s.heading;
  j.hips.position.y = Math.max((HIP_Y + a.hip) * H, 0.07 * H);
  j.hips.rotation.x = -a.flat * Math.PI / 2;
  j.torso.rotation.x = a.lean;
  j.head.rotation.x = a.head;
  j.lArm.rotation.set(a.lArmX, 0, a.lArmZ);
  j.rArm.rotation.set(a.rArmX, 0, a.rArmZ);
  j.lElbow.rotation.x = a.lElbow;
  j.rElbow.rotation.x = a.rElbow;
  j.lLeg.rotation.x = a.lLeg;
  j.rLeg.rotation.x = a.rLeg;
  j.lKnee.rotation.x = a.lKnee;
  j.rKnee.rotation.x = a.rKnee;
}

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose();
    o.material?.dispose();
  });
}

// Depth pass for control frames: white is close, black is far (inverse distance),
// the convention depth-guided video models are trained on.
const depthMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uNear: { value: 2 } },
  vertexShader: 'varying float vDist; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform float uNear; varying float vDist; void main(){ float v = clamp(uNear / max(vDist, 0.001), 0.0, 1.0); gl_FragColor = vec4(vec3(v), 1.0); }',
});
const BLACK = new THREE.Color(0x000000);

export class Stage3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 400);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a96, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(6, 12, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(40, 40, 0x000000, 0x000000);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.1;
    this.grid.position.y = 0.004;
    this.scene.add(this.grid);

    this.things = new THREE.Group();
    this.scene.add(this.things);
    this.figures = new Map();
    this.shape = '';
  }

  /** Rebuilds meshes only when something structural changed (not on every move). */
  sync(scene) {
    const shape = JSON.stringify([scene.aspect, scene.ground, scene.sky, scene.props, scene.actors.map((a) => [a.id, a.color, a.height])]);
    if (shape === this.shape) return;
    this.shape = shape;
    const [w, h] = ASPECTS[scene.aspect];
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.scene.background = new THREE.Color(scene.sky);
    this.scene.fog = new THREE.Fog(scene.sky, 40, 160);
    this.ground.material.color.set(scene.ground);
    dispose(this.things);
    this.things.clear();
    this.figures.clear();
    for (const p of scene.props) {
      const geo = p.kind === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 28) : new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.85 }));
      mesh.scale.set(p.w, p.h, p.d);
      mesh.position.set(p.x, p.h / 2, p.z);
      mesh.rotation.y = -rad(p.rot);
      mesh.castShadow = mesh.receiveShadow = true;
      this.things.add(mesh);
    }
    for (const a of scene.actors) {
      const fig = buildFigure(a.color, a.height);
      this.figures.set(a.id, fig);
      this.things.add(fig);
    }
  }

  /** depthNear: when set, draws the depth pass; anything this close or closer is pure white. */
  render(scene, t, { grid = true, depthNear = 0 } = {}) {
    this.sync(scene);
    for (const a of scene.actors) applyPose(this.figures.get(a.id), sampleActor(a, t), t);
    const c = sampleCamera(scene, t);
    this.camera.position.set(...c.pos);
    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(...c.target);
    this.grid.visible = grid && !depthNear;
    if (!depthNear) return this.renderer.render(this.scene, this.camera);
    this.depth ??= depthMaterial();
    this.depth.uniforms.uNear.value = depthNear;
    const { background, fog } = this.scene;
    Object.assign(this.scene, { background: BLACK, fog: null, overrideMaterial: this.depth });
    this.renderer.render(this.scene, this.camera);
    Object.assign(this.scene, { background, fog, overrideMaterial: null });
  }
}
