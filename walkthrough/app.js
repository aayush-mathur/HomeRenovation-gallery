import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { isSafe, move, movementVector, roomAt } from './navigation.js';

const $ = id => document.getElementById(id);
const publicSite = document.documentElement.dataset.hosting === 'public';
const hostingLabel = publicSite ? 'Public walkthrough' : 'Local only';
$('model-version').textContent = hostingLabel;
document.title = `House walkthrough · ${publicSite ? 'Furnished home' : 'Local preview'}`;
const canvas = $('view'), stage = $('stage'), room = $('room'), status = $('status');
const lifetime = new AbortController();
const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
const keys = new Set(), touches = new Map();
let renderer, scene, camera, model, nav, manifest, frame, previous = 0;
let yaw = 0, pitch = 0, ready = false, dragging = null, loadController, observer;
let selected = 'kitchen', position = [0, 0], disposed = false, blocked = false, contextLost = false;
let currentRoom = '';
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);

function clearInput() {
  keys.clear(); touches.clear(); dragging = null;
}
function release() {
  clearInput();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}
function message(text) { status.textContent = text; }
function orientation() {
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}
function look(dx, dy) {
  yaw -= dx * .003;
  pitch = THREE.MathUtils.clamp(pitch - dy * .003, -1.35, 1.35);
  orientation();
}
function teleport(id) {
  const preset = nav.presets.find(p => p.id === id);
  if (!preset || !isSafe(nav, ...preset.position)) throw new Error('Room has no validated safe position.');
  release();
  selected = id;
  position = preset.position.slice(0, 2);
  const dx = preset.target[0] - position[0], dy = preset.target[1] - position[1];
  yaw = Math.atan2(-dx, dy);
  pitch = Math.atan2(preset.target[2] - preset.position[2], Math.hypot(dx, dy));
  camera.position.set(position[0], 1.6, -position[1]);
  orientation();
  room.value = id;
  blocked = false;
  currentRoom = id;
  message(`${preset.name} · eye height 1.6 m`);
}
function disposeModel() {
  if (!model) return;
  scene.remove(model);
  model.traverse(obj => {
    obj.geometry?.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) mat?.dispose();
  });
  model = null;
}
function failure(error) {
  ready = false;
  release();
  stage.dataset.state = 'error';
  $('loading').hidden = false;
  $('loading-title').textContent = 'The house could not open';
  $('loading-detail').textContent = `${error.message} ${publicSite
    ? 'Check your connection and retry. If it persists, the published assets need attention.'
    : 'Check the local export and server, then retry.'}`;
  $('retry').hidden = false;
  for (const id of ['room', 'reset', 'capture']) $(id).disabled = true;
  message('Preview unavailable · retry loading');
}
async function checkedFetch(path, signal) {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}
async function verifyHash(bytes, expected, label) {
  if (!expected) throw new Error(`${label} is not validated. Regenerate the export and navigation.`);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== expected) throw new Error(`${label} does not match the manifest. Regenerate both export steps.`);
}
async function load() {
  loadController?.abort();
  loadController = new AbortController();
  const signal = loadController.signal;
  ready = false; release(); disposeModel();
  stage.dataset.state = 'loading';
  $('loading').hidden = false; $('retry').hidden = true;
  $('loading-title').textContent = 'Opening the full house';
  $('loading-detail').textContent = 'Loading full-height house geometry. Nothing is uploaded.';
  for (const id of ['room', 'reset', 'capture']) $(id).disabled = true;
  try {
    manifest = await (await checkedFetch('./model/manifest.json', signal)).json();
    if (manifest.layout_revision) $('clearance-note').textContent = 'The middle room keeps its full 2.061 m square bed. Furniture aisles remain tight; the 400 mm preview body is not an accessible-design approval.';
    const navBytes = await (await checkedFetch(`./model/navigation.json?v=${manifest.navigation_sha256}`, signal)).arrayBuffer();
    $('model-version').textContent = `${hostingLabel} · ${manifest.source.split(/[\\/]/).at(-1).match(/v\d+/)?.[0] || 'house'}`;
    await verifyHash(navBytes, manifest.navigation_sha256, 'Navigation');
    nav = JSON.parse(new TextDecoder().decode(navBytes));
    if (!nav.presets?.length || nav.cells.length !== nav.width * nav.height) throw new Error('Navigation export is incomplete.');
    $('loading-detail').textContent = `Opening ${(manifest.bytes / 1e6).toFixed(1)} MB of house geometry…`;
    const bytes = await (await checkedFetch(`./model/house.glb?v=${manifest.model_sha256}`, signal)).arrayBuffer();
    await verifyHash(bytes, manifest.model_sha256, 'Model');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (disposed || signal.aborted) {
      gltf.scene.traverse(obj => { obj.geometry?.dispose(); obj.material?.dispose(); }); return;
    }
    model = gltf.scene;
    model.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true; obj.receiveShadow = true;
        if (obj.material.transparent) obj.material.depthWrite = false;
      }
    });
    scene.add(model);
    // The GLB contains the authored closed pose. Do not instantiate animation,
    // picking or dynamic collision controllers in this stability fallback.
    room.replaceChildren(...nav.presets.map(p => new Option(p.name, p.id)));
    teleport(nav.presets.some(p => p.id === selected) ? selected : nav.presets[0].id);
    ready = true;
    stage.dataset.state = 'ready';
    $('loading').hidden = true;
    for (const id of ['room', 'reset', 'capture']) $(id).disabled = false;
  } catch (error) { if (error.name !== 'AbortError') failure(error); }
}
function resize() {
  const { width, height } = stage.getBoundingClientRect();
  if (!renderer || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  // Cap horizontal FOV on ultrawide displays instead of stretching into fisheye.
  camera.fov = Math.min(62, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(45)) / camera.aspect)));
  camera.updateProjectionMatrix();
}
function animate(time) {
  if (disposed) return;
  frame = requestAnimationFrame(animate);
  const dt = previous ? THREE.MathUtils.clamp((time - previous) / 1000, 0, .05) : 0;
  previous = time;
  if (document.hidden) return;
  if (ready) {
    const down = code => keys.has(code) ? 1 : 0;
    const touch = name => [...touches.values()].includes(name) ? 1 : 0;
    if (keys.size) {
      yaw += (down('KeyQ') - down('KeyE')) * dt * 1.3;
      pitch = THREE.MathUtils.clamp(pitch + (down('KeyR') - down('KeyF')) * dt, -1.35, 1.35);
      orientation();
    }
    const forward = down('KeyW') + down('ArrowUp') + touch('forward') - down('KeyS') - down('ArrowDown') - touch('back');
    const sideways = down('KeyD') + down('ArrowRight') + touch('right') - down('KeyA') - down('ArrowLeft') - touch('left');
    const [dx, dy] = movementVector(forward, sideways, yaw, dt);
    const next = move(nav, position, dx, dy);
    const hit = Math.hypot(dx, dy) > 0 && Math.hypot(next[0] - position[0], next[1] - position[1]) < Math.hypot(dx, dy) * .2;
    const location = roomAt(nav, next);
    if (hit && !blocked) message('Wall or furniture · turn or sidestep to follow the clear aisle');
    if (!hit && (blocked || currentRoom !== location?.id)) message(`${location?.name || 'Passage'} · eye height 1.6 m`);
    currentRoom = location?.id;
    blocked = hit;
    position = next;
    camera.position.set(position[0], 1.6, -position[1]);
  }
  renderer.render(scene, camera);
}

on($('retry'), 'click', () => renderer && !contextLost ? load() : location.reload());
on(room, 'change', () => teleport(room.value));
on($('reset'), 'click', () => teleport(selected));
on($('fullscreen'), 'click', async () => {
  release();
  $('fullscreen').disabled = true;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      if (!document.documentElement.requestFullscreen) throw new Error('Unavailable');
      await document.documentElement.requestFullscreen();
    }
  } catch {
    message('Full screen is unavailable here · open the walkthrough in a browser that supports it');
  } finally {
    $('fullscreen').disabled = false;
  }
});
on(document, 'fullscreenchange', () => {
  release();
  const active = Boolean(document.fullscreenElement);
  $('fullscreen').textContent = active ? 'Exit full screen' : 'Full screen';
  $('fullscreen').setAttribute('aria-pressed', String(active));
  resize();
  if (ready) canvas.focus({ preventScroll: true });
});
function help(open) {
  release();
  $('instructions').hidden = !open;
  $('help').setAttribute('aria-expanded', String(open));
  if (open) $('close-help').focus(); else $('help').focus();
}
on($('help'), 'click', () => help($('instructions').hidden));
on($('close-help'), 'click', () => help(false));
on($('capture'), 'click', async () => {
  if (document.pointerLockElement === canvas) { release(); return; }
  canvas.focus();
  try {
    if (!canvas.requestPointerLock) throw new Error('Unavailable');
    await canvas.requestPointerLock();
  } catch { message('Mouse capture unavailable here · drag to look instead'); }
});
on(document, 'pointerlockchange', () => {
  clearInput();
  $('capture').textContent = document.pointerLockElement === canvas ? 'Release mouse' : 'Mouse look';
  message(document.pointerLockElement === canvas ? 'Mouse captured · Esc to release' : 'Drag to look · click the view to walk');
});
on(document, 'pointerlockerror', () => message('Mouse capture unavailable here · drag to look instead'));
on(canvas, 'pointerdown', event => {
  if (!ready || !$('instructions').hidden || event.button !== 0) return;
  canvas.focus({ preventScroll: true });
  if (document.pointerLockElement !== canvas) {
    dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  }
});
on(canvas, 'pointermove', event => {
  if (!dragging || dragging.id !== event.pointerId) return;
  look(event.clientX - dragging.x, event.clientY - dragging.y);
  dragging.x = event.clientX; dragging.y = event.clientY;
});
on(canvas, 'pointerup', () => { dragging = null; });
for (const type of ['pointercancel', 'lostpointercapture']) {
  on(canvas, type, () => { dragging = null; });
}
on(document, 'mousemove', event => {
  if (ready && document.pointerLockElement === canvas) look(event.movementX, event.movementY);
});
on(document, 'keydown', event => {
  if (event.code === 'Escape') { release(); if (!$('instructions').hidden) help(false); return; }
  if (!ready || !$('instructions').hidden || event.altKey || event.ctrlKey || event.metaKey) return;
  if (document.activeElement !== canvas && document.pointerLockElement !== canvas) return;
  if (event.code === 'Space') {
    event.preventDefault();
    return;
  }
  if (movementKeys.has(event.code)) { event.preventDefault(); keys.add(event.code); }
});
on(document, 'keyup', event => keys.delete(event.code));
on(canvas, 'blur', clearInput);
on(window, 'blur', release);
on(document, 'visibilitychange', () => { release(); previous = 0; });
for (const button of document.querySelectorAll('[data-move]')) {
  on(button, 'pointerdown', event => {
    if (!ready || !$('instructions').hidden) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, button.dataset.move);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(button, type, event => touches.delete(event.pointerId));
  on(button, 'keydown', event => {
    if (ready && ['Space', 'Enter'].includes(event.code)) { event.preventDefault(); touches.set(button.dataset.move, button.dataset.move); }
  });
  on(button, 'keyup', () => touches.delete(button.dataset.move));
  on(button, 'blur', () => touches.delete(button.dataset.move));
}
on(canvas, 'webglcontextlost', event => { event.preventDefault(); contextLost = true; failure(new Error('WebGL context was lost. Retry will reload this page.')); });
on(canvas, 'webglcontextrestored', () => location.reload());

function cleanup() {
  disposed = true; ready = false; release(); loadController?.abort();
  cancelAnimationFrame(frame); observer?.disconnect(); lifetime.abort();
  disposeModel(); renderer?.dispose();
}
on(window, 'pagehide', cleanup);
// A restored bfcache page needs a fresh renderer after pagehide disposal.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
// Read-only diagnostics used by the local browser regression suite.
window.walkthrough = { snapshot: () => ({
  ready, position: [...position], yaw, pitch, selected, currentRoom,
  safe: nav ? isSafe(nav, ...position) : false,
  pressed: keys.size + touches.size, dragging: Boolean(dragging),
  triangles: renderer?.info.render.triangles, calls: renderer?.info.render.calls,
  fov: camera?.fov, eyeHeight: camera?.position.y,
  storage: { enabled: false, mode: 'closed' },
}), geometrySnapshot: () => {
  const meshes = [];
  model?.traverse(obj => {
    if (obj.isMesh) meshes.push({ name: obj.name, matrix: obj.matrixWorld.toArray() });
  });
  return meshes;
} };

try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6eb');
  camera = new THREE.PerspectiveCamera(62, 1, .06, 80);
  scene.add(new THREE.HemisphereLight(0xf3f5ff, 0xc6b9a6, 2.1));
  const sun = new THREE.DirectionalLight(0xfff2de, 2.5);
  sun.position.set(5, 10, -8); sun.target.position.set(3, 0, -10);
  scene.add(sun, sun.target);
  // Soft fill keeps enclosed rooms readable; these are not lighting-design fixtures.
  for (const [x, y] of [[2, 15], [1.3, 11.6], [3, 7.8], [6.5, 16], [6.5, 8], [5, 2.5], [1.6, 2.5]]) {
    const fill = new THREE.PointLight(0xfff5e9, 11, 7, 2);
    fill.position.set(x, 2.6, -y); scene.add(fill);
  }
  observer = new ResizeObserver(resize); observer.observe(stage);
  resize(); frame = requestAnimationFrame(animate); load();
} catch (error) { failure(new Error(`WebGL initialization failed: ${error.message}`)); }
