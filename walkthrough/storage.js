import * as THREE from 'three';

export const REACH = 1.8;
const MOTION_MARGIN = .015;

export function transformedBox(box, spec, amount) {
  const [a, b] = box;
  let center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const angle = spec.type === 'hinge' ? spec.angle * amount : 0;
  if (spec.type === 'hinge') {
    const dx = center[0] - spec.pivot[0], dy = center[1] - spec.pivot[1];
    center = [spec.pivot[0] + dx * Math.cos(angle) - dy * Math.sin(angle),
      spec.pivot[1] + dx * Math.sin(angle) + dy * Math.cos(angle)];
  } else {
    center = center.map((v, i) => v + spec.translation[i] * amount);
  }
  const dz = spec.type === 'hinge' ? 0 : spec.translation[2] * amount;
  return { center, half: [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2],
    angle, z: [a[2] + dz, b[2] + dz] };
}

export function hitsBody(rect, position, radius) {
  if (rect.z[1] <= .12 || rect.z[0] >= 1.9) return false;
  const dx = position[0] - rect.center[0], dy = position[1] - rect.center[1];
  const x = Math.abs(dx * Math.cos(rect.angle) + dy * Math.sin(rect.angle));
  const y = Math.abs(-dx * Math.sin(rect.angle) + dy * Math.cos(rect.angle));
  return Math.hypot(Math.max(0, x - rect.half[0]), Math.max(0, y - rect.half[1])) < radius;
}

export function boxesOverlap(a, b) {
  if (a.z[1] <= b.z[0] + .001 || b.z[1] <= a.z[0] + .001) return false;
  const axes = [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2];
  for (const axis of axes) {
    const project = rect => rect.half[0] * Math.abs(Math.cos(rect.angle - axis))
      + rect.half[1] * Math.abs(Math.sin(rect.angle - axis));
    const distance = Math.abs((b.center[0] - a.center[0]) * Math.cos(axis)
      + (b.center[1] - a.center[1]) * Math.sin(axis));
    if (distance >= project(a) + project(b) - .001) return false;
  }
  return true;
}

export class StorageController {
  constructor(model, camera, data, viewer, notify) {
    this.model = model; this.camera = camera; this.viewer = viewer; this.notify = notify;
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(0, 0);
    this.selected = null; this.target = null;
    this.pickElapsed = .1;
    this.actions = new Map();
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const spec of data?.interactions || []) {
      const nodes = [];
      model.traverse(obj => { if (obj.userData.storage_interaction === spec.id) nodes.push(obj); });
      if (!nodes.length) throw new Error(`Missing articulated node for ${spec.label}`);
      this.actions.set(spec.id, { spec, nodes, amount: 0, target: 0, matrices: nodes.map(n => n.matrix.clone()) });
    }
    model.updateMatrixWorld(true);
  }

  pointerAt(x, y, rectangle) {
    this.pointer.set((x - rectangle.left) / rectangle.width * 2 - 1, -(y - rectangle.top) / rectangle.height * 2 + 1);
  }

  pick() {
    this.camera.updateMatrixWorld(true);
    this.ray.setFromCamera(this.pointer, this.camera);
    this.ray.far = REACH;
    const hit = this.ray.intersectObject(this.model, true)[0];
    this.lastHit = hit ? { distance: hit.distance, interaction: hit.object.userData.storage_interaction || null,
      role: hit.object.userData.storage_role || null, object: hit.object.name } : null;
    return hit ? this.actions.get(hit.object.userData.storage_interaction) : undefined;
  }

  inReach(action) {
    const box = transformedBox(action.spec.boxes[0], action.spec, action.amount);
    const dx = this.camera.position.x - box.center[0], dy = -this.camera.position.z - box.center[1];
    const c = Math.cos(box.angle), s = Math.sin(box.angle);
    const x = THREE.MathUtils.clamp(dx * c + dy * s, -box.half[0], box.half[0]);
    const y = THREE.MathUtils.clamp(-dx * s + dy * c, -box.half[1], box.half[1]);
    const point = new THREE.Vector3(box.center[0] + x * c - y * s,
      Math.min(box.z[1], Math.max(box.z[0], this.camera.position.y)), -(box.center[1] + x * s + y * c));
    const delta = point.clone().sub(this.camera.position);
    return delta.length() <= REACH && delta.dot(this.camera.getWorldDirection(new THREE.Vector3())) > 0;
  }

  rects(action, amount = action.amount) {
    return action.spec.boxes.map(box => transformedBox(box, action.spec, amount));
  }

  canStand(x, y) {
    const radius = this.viewer().radius + MOTION_MARGIN;
    return ![...this.actions.values()].some(action =>
      action.amount > .0001 && this.rects(action).some(rect => hitsBody(rect, [x, y], radius)));
  }

  obstruction(action, amount) {
    const viewer = this.viewer();
    const rects = this.rects(action, amount);
    if (rects.some(rect => hitsBody(rect, viewer.position, viewer.radius + MOTION_MARGIN))) return 'Step back or to the side; you are in its path.';
    for (const other of this.actions.values()) {
      if (action === other) continue;
      if (rects.some(a => this.rects(other).some(b => boxesOverlap(a, b)))) return `Close or move away from ${other.spec.label} first.`;
    }
    return null;
  }

  sweepObstruction(action, target) {
    const steps = Math.max(1, Math.ceil(Math.abs(target - action.amount) * 90));
    for (let i = 1; i <= steps; i++) {
      const reason = this.obstruction(action, action.amount + (target - action.amount) * i / steps);
      if (reason) return reason;
    }
    return null;
  }

  activate(action) {
    action ??= this.pick() || this.target;
    if (!action || !this.inReach(action)) { this.notify('Move closer and point at a cabinet front or handle.'); return false; }
    this.selected = action;
    if (action.spec.max_open < .045) {
      this.notify(`Cannot open ${action.spec.label}: clearance conflict with ${(action.spec.limited_by || ['fixed furniture']).join(', ')}.`);
      return false;
    }
    const target = action.amount > .01 ? 0 : action.spec.max_open;
    const reason = this.sweepObstruction(action, target);
    if (reason) { this.notify(reason); return false; }
    action.target = target;
    this.notify(`${target ? 'Opening' : 'Closing'} ${action.spec.label}${target && target < .99 ? ' · limited by existing clearance' : ''}. Proposed internals.`);
    return true;
  }

  apply(action, amount) {
    action.amount = amount;
    const matrix = new THREE.Matrix4();
    if (action.spec.type === 'hinge') {
      const p = action.spec.pivot;
      matrix.makeTranslation(p[0], p[2], -p[1]);
      matrix.multiply(new THREE.Matrix4().makeRotationY(action.spec.angle * amount));
      matrix.multiply(new THREE.Matrix4().makeTranslation(-p[0], -p[2], p[1]));
    } else {
      const v = action.spec.translation;
      matrix.makeTranslation(v[0] * amount, v[2] * amount, -v[1] * amount);
    }
    action.nodes.forEach((node, i) => {
      node.matrixAutoUpdate = false;
      node.matrix.copy(matrix).multiply(action.matrices[i]);
      node.matrixWorldNeedsUpdate = true;
    });
  }

  update(dt) {
    if (!this.actions.size) return;
    for (const action of this.actions.values()) {
      if (Math.abs(action.target - action.amount) < .00001) continue;
      const next = this.reducedMotion ? action.target : action.amount
        + Math.sign(action.target - action.amount) * Math.min(dt * 1.4, Math.abs(action.target - action.amount));
      const reason = this.sweepObstruction(action, next);
      if (reason) { action.target = action.amount; this.notify(`Motion stopped. ${reason}`); }
      else {
        this.apply(action, next);
        if (Math.abs(next - action.target) < .00001) this.notify(`${next > .01 ? 'Open' : 'Closed'}: ${action.spec.label}. Proposed internals.`);
      }
    }
    this.model.updateMatrixWorld(true);
    this.pickElapsed += dt;
    if (this.pickElapsed < .1) return;
    this.pickElapsed = 0;
    const hovered = this.pick();
    this.target = hovered || (this.selected && this.inReach(this.selected) ? this.selected : null);
    const prompt = document.getElementById('storage-name'), button = document.getElementById('storage-action');
    if (!this.target) {
      prompt.textContent = 'Point at nearby storage · Space or tap to interact';
      button.disabled = true; button.textContent = 'Open storage';
      button.setAttribute('aria-label', 'Open nearby storage');
    } else {
      const { spec, amount } = this.target;
      prompt.textContent = `${spec.label} · ${amount > .01 ? 'open' : 'closed'} · proposed${spec.max_open < .99 ? ' · clearance-limited' : ''}`;
      button.textContent = amount > .01 ? 'Close' : 'Open';
      button.setAttribute('aria-label', `${amount > .01 ? 'Close' : 'Open'} ${spec.label}`);
      button.disabled = spec.max_open < .045;
    }
  }

  snapshot() {
    return { target: this.target?.spec.id || null, hit: this.lastHit || null,
      states: [...this.actions.values()].map(a => ({ id: a.spec.id, label: a.spec.label, amount: a.amount, target: a.target, maxOpen: a.spec.max_open })) };
  }
}
