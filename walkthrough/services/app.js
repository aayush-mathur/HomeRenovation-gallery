import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { joystickVector } from '../navigation.js?controls=4';

const $ = selector => document.querySelector(selector);
const canvas = $('#model');
const stage = $('#stage');
const layerInputs = [...document.querySelectorAll('#layers input')];
const viewButtons = [...document.querySelectorAll('[data-view]')];
const labels = { normal: 'Normal supply', backup: 'Requested backup', data: 'Data', cold: 'Cold water',
  hot: 'Hot water', waste: 'Waste', vent: 'Drain vent', access: 'Service access', context: 'Context' };
const palette = { normal: '#1447cc', backup: '#b96806', data: '#24713f', cold: '#008898',
  hot: '#b92520', waste: '#782da0', vent: '#97388d', access: '#317553', context: '#758793' };
const traceableRoles = new Set(['service', 'cable', 'lighting-feed', 'equipment-feed']);
let renderer, scene, camera, controls, model, manifest, highlight, traced, traceSelection, loading = false;
let mode = 'orbit', preset = 'all', selectedRoom = '';
const buckets = [];
const center = new THREE.Vector3(4.5, 1.2, -8.8);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down;
let lookPointer = null, yaw = 0, pitch = 0, motionFrame = null, lastMotion = 0;
const held = new Set();
const movePointers = new Map();
const stick = $('#services-stick');
let stickPointer = null, stickOrigin = null, stickInput = [0, 0];
const movementKeys = new Set(['w','a','s','d','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','q','e','r','f','PageUp','PageDown']);

function stopMotion() {
  held.clear();
  movePointers.clear();
  resetStick();
  if (motionFrame !== null) cancelAnimationFrame(motionFrame);
  motionFrame = null;
  for (const button of document.querySelectorAll('[data-move]')) button.setAttribute('aria-pressed', 'false');
}

function resetStick() {
  const pointerId = stickPointer;
  stickPointer = null; stickOrigin = null; stickInput = [0, 0];
  stick.firstElementChild.style.transform = '';
  stick.setAttribute('aria-pressed', 'false');
  if (pointerId !== null && stick.hasPointerCapture(pointerId)) stick.releasePointerCapture(pointerId);
}

function updateLook() {
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  render();
}

function moveFrame(now) {
  motionFrame = null;
  if (stickPointer !== null && !stick.hasPointerCapture(stickPointer)) resetStick();
  if (mode !== 'walk' || (!held.size && !movePointers.size && stickPointer === null)) return;
  const dt = Math.min((now - lastMotion) / 1000, .05);
  lastMotion = now;
  const keys = new Set([...held, ...movePointers.values()]);
  const forward = Number(keys.has('w') || keys.has('ArrowUp')) - Number(keys.has('s') || keys.has('ArrowDown')) + stickInput[1];
  const side = Number(keys.has('d') || keys.has('ArrowRight')) - Number(keys.has('a') || keys.has('ArrowLeft')) + stickInput[0];
  const length = Math.max(1, Math.hypot(forward, side));
  yaw += (Number(keys.has('q')) - Number(keys.has('e'))) * dt * 1.3;
  pitch = THREE.MathUtils.clamp(pitch + (Number(keys.has('r')) - Number(keys.has('f'))) * dt, -1.45, 1.45);
  camera.position.y = THREE.MathUtils.clamp(
    camera.position.y + (Number(keys.has('PageUp')) - Number(keys.has('PageDown'))) * dt * .8,
    .814, 3.014);
  const speed = dt * 1.35 / length;
  camera.position.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * side) * speed;
  camera.position.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * side) * speed;
  // Inspection is deliberately unrestricted by walls, but remains at eye height
  // and within a small margin of this floor, not a fictional stair/roof route.
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -.5, 9.5);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -18.2, .5);
  updateLook();
  motionFrame = requestAnimationFrame(moveFrame);
}

function startMotion() {
  if (motionFrame !== null) return;
  lastMotion = performance.now();
  motionFrame = requestAnimationFrame(moveFrame);
}

function render() {
  if (!renderer) return;
  renderer.render(scene, camera);
}

function resize() {
  if (!camera) return;
  const { width, height } = stage.getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  const aspect = width / height;
  if (camera.isOrthographicCamera) {
    const span = selectedRoom ? 7 : 20;
    camera.left = -span * aspect / 2; camera.right = span * aspect / 2;
    camera.top = span / 2; camera.bottom = -span / 2;
  } else camera.aspect = aspect;
  camera.updateProjectionMatrix();
  render();
}

function setView(id, reset = true) {
  stopMotion();
  lookPointer = null;
  mode = id;
  document.body.classList.toggle('walk-mode', id === 'walk');
  const oldZoom = camera?.zoom ?? 1;
  controls?.dispose();
  controls = null;
  camera = id === 'plan' ? new THREE.OrthographicCamera(-10, 10, 10, -10, .05, 150)
    : new THREE.PerspectiveCamera(45, 1, .05, 150);
  const room = manifest?.rooms.find(r => r.id === selectedRoom);
  const target = room ? new THREE.Vector3(room.center[0], 1, -room.center[1]) : center.clone();
  if (id === 'walk') {
    camera.fov = 62;
    camera.position.set(room ? room.center[0] : 4.3, 1.614, room ? -room.center[1] : -11.3);
    yaw = 0; pitch = 0;
    updateLook();
    for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === id));
    $('#movement').hidden = false;
    setFitLabel('Reset position');
    $('#view-note').textContent = 'Thumbstick or WASD to move · drag to look · Rise/Lower changes height · passes through walls';
    resize();
    canvas.focus({ preventScroll: true });
    return;
  }
  $('#movement').hidden = true;
  setFitLabel('Fit view');
  if (id === 'plan') {
    camera.up.set(0, 0, -1);
    camera.position.copy(target).add(new THREE.Vector3(0, 30, 0));
  } else camera.position.copy(target).add(room ? new THREE.Vector3(5, 6, 7) : new THREE.Vector3(13, 18, 22));
  camera.lookAt(target);
  camera.zoom = reset ? 1 : oldZoom;
  controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableRotate = id !== 'plan';
  controls.screenSpacePanning = true;
  controls.minDistance = 1; controls.maxDistance = 65;
  controls.minZoom = .4; controls.maxZoom = 12;
  controls.maxPolarAngle = Math.PI * .85;
  controls.addEventListener('change', render);
  controls.update();
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === id));
  $('#view-note').textContent = id === 'plan'
    ? 'Bird’s-eye · drag with the right mouse button to pan · scroll to zoom'
    : 'Drag to rotate · right-drag to pan · scroll to zoom';
  resize();
  if (id !== 'plan' && model && !room) {
    const bounds = new THREE.Box3().setFromObject(model);
    const direction = camera.position.clone().sub(target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    let distance = 1;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const delta = new THREE.Vector3(x,y,z).sub(target);
      distance = Math.max(distance, Math.abs(delta.dot(right)) / (tangent * camera.aspect) + delta.dot(direction),
        Math.abs(delta.dot(up)) / tangent + delta.dot(direction));
    }
    camera.position.copy(target).addScaledVector(direction, distance * 1.08);
    controls.update(); render();
  }
}

function setFitLabel(label) {
  $('#fit').setAttribute('aria-label', label);
  $('#fit-compact').textContent = label === 'Reset position' ? 'Reset' : 'Fit';
}

function setFullscreenLabel(active) {
  $('#fullscreen').setAttribute('aria-pressed', String(active));
  $('#fullscreen').setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
  $('#fullscreen').querySelector('.wide-label').textContent = active ? 'Exit full screen' : 'Full screen';
  $('#fullscreen-compact').textContent = active ? 'Exit' : 'Full';
}

function syncFullscreen() {
  const active = Boolean(document.fullscreenElement) || document.body.classList.contains('pseudo-fullscreen');
  setFullscreenLabel(active);
  resize();
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      $('#status').textContent = `Could not exit browser full screen (${error.message}). Press Escape or use the viewer control again.`;
    }
    return;
  }
  if (document.body.classList.contains('pseudo-fullscreen')) {
    document.body.classList.remove('pseudo-fullscreen');
    syncFullscreen();
    return;
  }
  if (!document.documentElement.requestFullscreen) {
    document.body.classList.add('pseudo-fullscreen');
    syncFullscreen();
    return;
  }
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    document.body.classList.add('pseudo-fullscreen');
    $('#status').textContent = `Browser full screen was unavailable (${error.message}); using expanded view instead.`;
    syncFullscreen();
  }
}

function routeName(label) {
  return label.replace(/\s+bend\s+\d+$/i, '').replace(/\s+\/\s+\d+$/, '').trim();
}

function clearTrace(resetSelection = false) {
  if (traced) {
    scene.remove(traced);
    for (const mesh of traced.children) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    traced = null;
  }
  if (resetSelection || !traced) {
    for (const { mesh, descriptor } of buckets) {
      if (['walls','floor'].includes(descriptor.role)) continue;
      mesh.material.transparent = false;
      mesh.material.opacity = 1;
      mesh.material.depthWrite = true;
    }
  }
  if (resetSelection) traceSelection = null;
  $('#trace-status').textContent = '';
  $('#clear-trace').hidden = true;
}

function traceRoute() {
  if (!traceSelection) return;
  if (traced) clearTrace(false);
  traced = new THREE.Group();
  model.updateMatrixWorld(true);
  let pieces = 0;
  for (const { mesh, descriptor } of buckets) {
    if (descriptor.system !== traceSelection.system || descriptor.role !== traceSelection.role) continue;
    const source = mesh.geometry;
    const positions = source.getAttribute('position');
    const indices = source.getIndex();
    const worldPositions = [];
    for (const item of descriptor.items) {
      if (routeName(item.label) !== traceSelection.name) continue;
      for (let face = item.first; face < item.first + item.count; face++) {
        for (let corner = 0; corner < 3; corner++) {
          const index = indices ? indices.getX(face * 3 + corner) : face * 3 + corner;
          const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld);
          worldPositions.push(point.x, point.y, point.z);
        }
      }
      pieces++;
    }
    if (!worldPositions.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(worldPositions, 3));
    traced.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: '#ffe052', side: THREE.DoubleSide, depthTest: false, depthWrite: false
    })));
  }
  traced.renderOrder = 20;
  for (const mesh of traced.children) mesh.renderOrder = 20;
  scene.add(traced);
  for (const { mesh, descriptor } of buckets) {
    if (['walls','floor'].includes(descriptor.role) || ['context','access'].includes(descriptor.system)) continue;
    mesh.material.transparent = true;
    mesh.material.opacity = .14;
    mesh.material.depthWrite = false;
  }
  $('#trace-status').textContent = `Highlighted ${pieces} connected-looking route pieces named “${traceSelection.name}”. This follows the proposed model path; it does not prove an electrically connected circuit.`;
  $('#clear-trace').hidden = false;
  render();
}

function updateLayers() {
  const enabled = new Set(layerInputs.filter(i => i.checked).map(i => i.value));
  const walls = $('#walls').value;
  for (const { mesh, descriptor } of buckets) {
    const { role, system } = descriptor;
    let visible = system === 'context' || system === 'access' || enabled.has(system);
    if (role === 'walls') {
      visible = walls !== 'hidden';
      mesh.material.transparent = walls === 'ghost';
      mesh.material.opacity = walls === 'ghost' ? .13 : 1;
      mesh.material.depthWrite = walls !== 'ghost';
      mesh.material.needsUpdate = true;
    }
    if (role === 'floor') { mesh.material.transparent = true; mesh.material.opacity = .18; mesh.material.depthWrite = false; }
    if (role === 'cable') visible &&= $('#cables').checked;
    if (['service', 'lighting-feed', 'equipment-feed'].includes(role)) visible &&= $('#carriers').checked;
    if (['access', 'driver'].includes(role)) visible &&= $('#access').checked;
    if (role === 'penetration') visible = $('#crossings').checked;
    if (preset === 'lighting' && !['floor', 'walls', 'board', 'luminaire', 'driver', 'lighting-feed', 'access', 'cable'].includes(role)) visible = false;
    if (preset === 'lighting' && ['cold','hot','waste','vent'].includes(system)) visible = false;
    if (preset === 'water' && ['board','luminaire','driver','lighting-feed','equipment-feed','cable'].includes(role)) visible = false;
    if (preset === 'water' && role === 'access' && system === 'access') visible = false;
    mesh.visible = visible;
  }
  clearSelection(false);
  render();
}

function clearSelection(draw = true) {
  clearTrace(true);
  if (highlight) { scene.remove(highlight); highlight.geometry.dispose(); highlight.material.dispose(); highlight = null; }
  $('#selection-title').textContent = 'Pick a route or fitting';
  $('#selection-text').textContent = 'Tap the visible model to inspect a segment. Transparent walls do not block selection.';
  $('#trace-route').hidden = true;
  $('#clear').hidden = true;
  if (draw) render();
}

function pick(event) {
  if (!model || !down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || event.button !== 0) return;
  const rect = canvas.getBoundingClientRect();
  pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
  raycaster.setFromCamera(pointer, camera);
  const pickable = buckets.filter(b => b.mesh.visible && !['floor','walls'].includes(b.descriptor.role));
  const hit = raycaster.intersectObjects(pickable.map(b => b.mesh), false)[0];
  if (!hit) { clearSelection(); return; }
  const bucket = pickable.find(b => b.mesh === hit.object);
  const item = bucket.descriptor.items.find(i => hit.faceIndex >= i.first && hit.faceIndex < i.first + i.count);
  if (!item) return;
  clearSelection(false);
  const geom = hit.object.geometry;
  const positions = geom.getAttribute('position');
  const points = [];
  for (let face = item.first; face < item.first + item.count; face++) {
    for (let j = 0; j < 3; j++) {
      const v = geom.index ? geom.index.getX(face * 3 + j) : face * 3 + j;
      const p = new THREE.Vector3().fromBufferAttribute(positions, v);
      points.push(p.x, p.y, p.z);
    }
  }
  const selected = new THREE.BufferGeometry();
  selected.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  highlight = new THREE.Mesh(selected, new THREE.MeshBasicMaterial({ color: 0x111111, wireframe: true, depthTest: false }));
  highlight.matrixAutoUpdate = false;
  highlight.matrix.copy(hit.object.matrixWorld);
  highlight.renderOrder = 10;
  scene.add(highlight);
  $('#selection-title').textContent = item.label;
  $('#selection-text').textContent = `${labels[bucket.descriptor.system] || 'Proposed provision'} · ${bucket.descriptor.role.replaceAll('-', ' ')}. Review geometry only; no approved sizing, energized connection or installation permission.`;
  if (traceableRoles.has(bucket.descriptor.role)) {
    traceSelection = { system: bucket.descriptor.system, role: bucket.descriptor.role, name: routeName(item.label) };
    $('#trace-route').hidden = false;
  }
  $('#clear').hidden = false;
  setPanel(true);
  $('#selection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  render();
}

async function load() {
  if (loading) return;
  loading = true;
  $('#retry').hidden = true;
  $('#loading').hidden = false;
  $('#load-status').textContent = 'Loading and verifying geometry…';
  try {
    const response = await fetch('./manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Manifest request failed (${response.status})`);
    const candidate = await response.json();
    if (candidate.version !== 1 || candidate.id !== 'services-v002' ||
        !/^services-[a-f0-9]{16}\.glb$/.test(candidate.model) || !/^[a-f0-9]{64}$/.test(candidate.sha256))
      throw new Error('Unrecognized services model binding');
    const asset = await fetch(`./${candidate.model}`);
    if (!asset.ok) throw new Error(`Model request failed (${asset.status})`);
    const bytes = await asset.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== candidate.sha256 || bytes.byteLength !== candidate.bytes) throw new Error('Model integrity check failed');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#e1e7eb');
      scene.add(new THREE.HemisphereLight(0xffffff, 0x8f9da7, 2.4));
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(5, 20, 6); scene.add(sun);
    }
    manifest = candidate;
    model = gltf.scene;
    scene.add(model);
    buckets.length = 0;
    for (const descriptor of manifest.layers) {
      const mesh = model.getObjectByName(descriptor.node);
      if (!mesh?.isMesh || mesh.geometry.getIndex().count / 3 !== descriptor.triangles) throw new Error(`Layer geometry mismatch: ${descriptor.node}`);
      mesh.material = new THREE.MeshBasicMaterial({ color: palette[descriptor.system] || '#758793',
        side: THREE.DoubleSide, toneMapped: false });
      buckets.push({ mesh, descriptor });
    }
    for (const room of manifest.rooms) {
      const option = document.createElement('option'); option.value = room.id; option.textContent = room.label;
      $('#room').append(option);
    }
    for (const text of manifest.limits) {
      const li = document.createElement('li'); li.textContent = text; $('#limits').append(li);
    }
    $('#loading').hidden = true;
    $('#status').textContent = 'Services v002 loaded. Proposed routes—not verified circuits or installation drawings.';
    canvas.dataset.loaded = manifest.id;
    setView(mode); updateLayers();
  } catch (error) {
    console.error(error);
    $('#load-status').textContent = `3D unavailable: ${error.message}. Check your connection or WebGL support, then retry.`;
    $('#retry').hidden = false;
  } finally { loading = false; }
}

for (const button of viewButtons) button.addEventListener('click', () => model && setView(button.dataset.view));
$('#fit').addEventListener('click', () => model && setView(mode));
$('#fullscreen').addEventListener('click', () => { void toggleFullscreen(); });
document.addEventListener('fullscreenchange', syncFullscreen);
$('#trace-route').addEventListener('click', traceRoute);
$('#clear-trace').addEventListener('click', () => { clearTrace(false); render(); });
$('#room').addEventListener('change', () => { selectedRoom = $('#room').value; if (model) setView(mode); });
for (const input of layerInputs) input.addEventListener('change', () => { preset = 'all'; updateLayers(); });
for (const id of ['walls','carriers','cables','access','crossings']) $(`#${id}`).addEventListener('change', updateLayers);
for (const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click', () => {
  preset = button.dataset.preset;
  const water = new Set(['cold','hot','waste','vent']);
  for (const input of layerInputs) input.checked = preset === 'all' || (preset === 'water' ? water.has(input.value) : !water.has(input.value));
  updateLayers();
});
$('#panel-toggle').addEventListener('click', () => {
  setPanel($('#panel').hidden);
});
function setPanel(open) {
  if (open) {
    stopMotion();
    if (lookPointer && canvas.hasPointerCapture(lookPointer.id)) canvas.releasePointerCapture(lookPointer.id);
    lookPointer = null; down = null;
  }
  $('#panel').hidden = !open;
  $('#panel-backdrop').hidden = !open;
  $('#panel-toggle').setAttribute('aria-expanded', String(open));
  $('#panel-toggle').textContent = open ? 'Close settings' : 'Settings';
}
$('#panel-close').addEventListener('click', () => setPanel(false));
$('#panel-backdrop').addEventListener('click', () => setPanel(false));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#panel').hidden) setPanel(false);
  else if (event.key === 'Escape' && document.body.classList.contains('pseudo-fullscreen')) {
    document.body.classList.remove('pseudo-fullscreen');
    syncFullscreen();
  }
});
$('#retry').addEventListener('click', load);
$('#clear').addEventListener('click', () => clearSelection());
canvas.addEventListener('pointerdown', e => {
  canvas.focus({ preventScroll: true });
  down = { x: e.clientX, y: e.clientY, moved: false };
  if (mode === 'walk' && e.button === 0 && lookPointer === null) {
    lookPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  }
});
canvas.addEventListener('pointermove', e => {
  if (mode !== 'walk' || lookPointer?.id !== e.pointerId) return;
  if (down && Math.hypot(e.clientX-down.x,e.clientY-down.y) > 6) down.moved = true;
  yaw -= (e.clientX-lookPointer.x)*.004;
  pitch = THREE.MathUtils.clamp(pitch-(e.clientY-lookPointer.y)*.004,-1.45,1.45);
  lookPointer.x = e.clientX; lookPointer.y = e.clientY;
  updateLook();
});
canvas.addEventListener('pointerup', e => {
  if (!down?.moved) pick(e);
  if (lookPointer?.id === e.pointerId) lookPointer = null;
});
canvas.addEventListener('pointercancel', () => { lookPointer = null; down = null; });
canvas.addEventListener('lostpointercapture', () => { lookPointer = null; });
canvas.addEventListener('keydown', event => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (mode === 'walk' && movementKeys.has(key)) {
    event.preventDefault();
    held.add(key); startMotion();
    return;
  }
  if (!controls) return;
  if (['+','=','-'].includes(event.key)) {
    event.preventDefault();
    if (camera.isOrthographicCamera) camera.zoom = THREE.MathUtils.clamp(camera.zoom * (event.key === '-' ? .9 : 1.1), .4, 12);
    else camera.position.sub(controls.target).multiplyScalar(event.key === '-' ? 1.1 : .9).add(controls.target);
  } else if (event.key.startsWith('Arrow')) {
    event.preventDefault();
    const delta = new THREE.Vector3(event.key === 'ArrowLeft' ? -.3 : event.key === 'ArrowRight' ? .3 : 0, 0,
      event.key === 'ArrowUp' ? -.3 : event.key === 'ArrowDown' ? .3 : 0);
    camera.position.add(delta); controls.target.add(delta);
  } else return;
  camera.updateProjectionMatrix(); controls.update(); render();
});
window.addEventListener('keyup', e => held.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
canvas.addEventListener('blur', () => { held.clear(); });
window.addEventListener('blur', stopMotion);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopMotion(); });
stick.addEventListener('pointerdown', event => {
  if (mode !== 'walk' || loading || stickPointer !== null || event.button !== 0) return;
  event.preventDefault();
  stick.focus({ preventScroll: true });
  stickPointer = event.pointerId;
  stickOrigin = [event.clientX, event.clientY];
  stick.setPointerCapture(event.pointerId);
  stick.setAttribute('aria-pressed', 'true');
  startMotion();
});
stick.addEventListener('pointermove', event => {
  if (event.pointerId !== stickPointer) return;
  const x = event.clientX - stickOrigin[0], y = event.clientY - stickOrigin[1];
  stickInput = joystickVector(x, y);
  const scale = Math.min(1, 40 / (Math.hypot(x, y) || 1));
  stick.firstElementChild.style.transform = `translate(${x * scale}px, ${y * scale}px)`;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  stick.addEventListener(name, event => { if (event.pointerId === stickPointer) resetStick(); });
}
stick.addEventListener('keydown', event => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (mode !== 'walk' || !movementKeys.has(key)) return;
  event.preventDefault(); held.add(key); startMotion();
});
stick.addEventListener('blur', () => held.clear());
for (const button of document.querySelectorAll('[data-move]')) {
  button.setAttribute('aria-pressed','false');
  button.addEventListener('pointerdown', event => {
    if (mode !== 'walk') return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    movePointers.set(event.pointerId,button.dataset.move);
    button.setAttribute('aria-pressed','true');
    startMotion();
  });
  const release = event => {
    movePointers.delete(event.pointerId);
    button.setAttribute('aria-pressed','false');
  };
  for (const name of ['pointerup','pointercancel','lostpointercapture']) button.addEventListener(name, release);
  button.addEventListener('keydown', e => {
    if (mode !== 'walk' || ![' ','Enter'].includes(e.key)) return;
    e.preventDefault(); held.add(button.dataset.move); startMotion();
  });
  button.addEventListener('keyup', e => {
    if ([' ','Enter'].includes(e.key)) { e.preventDefault(); held.delete(button.dataset.move); }
  });
  button.addEventListener('blur', () => held.delete(button.dataset.move));
}
canvas.addEventListener('webglcontextlost', event => {
  stopMotion();
  event.preventDefault(); $('#loading').hidden = false;
  $('#load-status').textContent = 'Graphics context lost. Reload this page to restore the model.';
});
new ResizeObserver(resize).observe(stage);
window.servicesViewer = { snapshot: () => ({
  mode, position: camera?.position.toArray(), yaw, pitch,
  joystick: { active: stickPointer !== null, input: [...stickInput] },
}) };
load();
