import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { isSafe, move, movementVector, joystickVector, roomAt, applyLens } from './navigation.js?lens=1&controls=2';
import { validateCeilingOptions, createCeilingComparison, disposeCeiling } from './ceiling-comparison.js?v=3868c82db2f0f29b';
import { createFixtureLighting } from './fixture-lighting.js?v=07ea12a8efadecfe';

const $ = id => document.getElementById(id);
const publicSite = document.documentElement.dataset.hosting === 'public';
const hostingLabel = publicSite ? 'Public walkthrough' : 'Local only';
$('model-version').textContent = hostingLabel;
document.title = `House walkthrough · ${publicSite ? 'Furnished home' : 'Local preview'}`;
const canvas = $('view'), stage = $('stage'), room = $('room'), status = $('status');
const lifetime = new AbortController();
const on = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
const keys = new Set();
const stick = $('touch-stick');
let stickPointer = null, stickOrigin = null, stickInput = [0, 0];
let renderer, scene, camera, model, nav, manifest, frame, previous = 0;
let yaw = 0, pitch = 0, ready = false, dragging = null, loadController, observer;
let selected = 'kitchen', position = [0, 0], disposed = false, blocked = false, contextLost = false;
let currentRoom = '';
let focalLength = null, lens;
let ceilings, ceilingOptions, ceilingUnavailable = '';
let fixtureLighting;
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);

function clearInput() {
  keys.clear();
  resetStick();
  const pointer = dragging?.id;
  dragging = null;
  if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
}
function resetStick() {
  const pointer = stickPointer;
  stickPointer = null; stickOrigin = null; stickInput = [0, 0];
  stick.firstElementChild.style.transform = '';
  stick.removeAttribute('data-active');
  if (pointer !== null && stick.hasPointerCapture(pointer)) stick.releasePointerCapture(pointer);
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
  disposeCeilings();
  if (!model) return;
  scene.remove(model);
  model.traverse(obj => {
    obj.geometry?.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) mat?.dispose();
  });
  model = null;
}
function disposeCeilings() {
  ceilings?.dispose(); ceilings = null; ceilingOptions = null; ceilingUnavailable = '';
  for (const id of ['ceiling-controls', 'ceiling-feedback', 'ceiling-help', 'quality']) $(id).hidden = true;
  document.querySelector('header').classList.remove('has-ceilings');
}
function renderCeilings(state) {
  const variant = state.qualityActive ? ceilingOptions?.quality : ceilingOptions?.variants.find(v => v.id === state.selected);
  const pending = state.pendingQuality ? ceilingOptions?.quality : ceilingOptions?.variants.find(v => v.id === state.pending);
  $('ceiling').value = state.pending || state.selected;
  $('ceiling').setAttribute('aria-busy', String(Boolean(state.pending)));
  $('ceiling-status').textContent = state.error || (pending
    ? `Loading ${pending.label}… Still showing ${variant?.label || 'Existing'}.`
    : `${variant?.summary || 'Original ceiling and fixtures.'} Concepts only · web lighting is approximate.`);
  $('ceiling-feedback').dataset.error = String(Boolean(state.error));
  $('ceiling-retry').hidden = !state.failed;
  $('quality').hidden = !ceilingOptions?.quality || state.selected !== 'sculpted';
  $('quality').disabled = Boolean(state.pending);
  $('quality').setAttribute('aria-pressed', String(state.qualityActive));
  $('quality').textContent = state.pendingQuality ? 'Loading baked preview…' : state.qualityActive ? 'Use standard lighting' : 'Try baked lighting';
}
function setupCeilings() {
  try {
    ceilingOptions = validateCeilingOptions(manifest, document.baseURI);
    if (!ceilingOptions) return;
    ceilings = createCeilingComparison({
      options: ceilingOptions, model, scene,
      parse: async bytes => {
        const loader = new GLTFLoader();
        loader.register(parser => {
          // Embedded browsers can expose createImageBitmap while rejecting its
          // blob-fetch/decode path. Decode verified embedded PNGs as images.
          const textures = new THREE.TextureLoader(parser.options.manager);
          textures.setCrossOrigin(parser.options.crossOrigin);
          return {
            name: 'EMBEDDED_PNG_COMPATIBILITY',
            loadTexture(index) {
              const source = parser.json.textures[index]?.source;
              const image = parser.json.images?.[source];
              if (!image || image.mimeType !== 'image/png' || !Number.isInteger(image.bufferView)) return null;
              return parser.loadTextureImage(index, source, textures);
            },
          };
        });
        const result = await loader.parseAsync(bytes, '');
        const length = new DataView(bytes).getUint32(12, true);
        const document = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
        const images = new Set();
        result.scene.traverse(obj => {
          for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
            if (!mat) continue;
            for (const value of Object.values(mat)) {
              if (value?.isTexture && value.source?.data?.width > 0) images.add(value.source.data);
            }
          }
        });
        if (images.size < (document.images?.length || 0)) {
          disposeCeiling(result.scene);
          throw new Error('Baked textures could not decode; the existing view has been retained');
        }
        // Baked display surfaces are not authored diffusers or live fixtures.
        if (!(document.images?.length)) fixtureLighting.register(result.scene);
        return result;
      },
      onChange: renderCeilings,
    });
    $('ceiling').replaceChildren(new Option('Existing', 'existing'),
      ...ceilingOptions.variants.map(v => new Option(v.label, v.id)));
    $('ceiling-note').textContent = ceilingOptions.note;
    for (const id of ['ceiling-controls', 'ceiling-feedback', 'ceiling-help']) $(id).hidden = false;
    document.querySelector('header').classList.add('has-ceilings');
    renderCeilings(ceilings.snapshot());
  } catch (error) {
    ceilingUnavailable = `${error.message} Showing Existing; walking is unchanged.`;
    $('ceiling-feedback').hidden = false;
    $('ceiling-feedback').dataset.error = 'true';
    $('ceiling-status').textContent = ceilingUnavailable;
    $('ceiling-retry').hidden = true;
  }
}
function failure(error) {
  disposeCeilings();
  ready = false;
  release();
  stage.dataset.state = 'error';
  $('loading').hidden = false;
  $('loading-title').textContent = 'The house could not open';
  $('loading-detail').textContent = `${error.message} ${publicSite
    ? 'Check your connection and retry. If it persists, the published assets need attention.'
    : 'Check the local export and server, then retry.'}`;
  $('retry').hidden = false;
  for (const id of ['room', 'reset', 'capture', 'lens', 'reset-lens']) $(id).disabled = true;
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
  for (const id of ['room', 'reset', 'capture', 'lens', 'reset-lens']) $(id).disabled = true;
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
    fixtureLighting.setRooms(nav.rooms);
    fixtureLighting.register(model);
    setupCeilings();
    // The GLB contains the authored closed pose. Do not instantiate animation,
    // picking or dynamic collision controllers in this stability fallback.
    room.replaceChildren(...nav.presets.map(p => new Option(p.name, p.id)));
    teleport(nav.presets.some(p => p.id === selected) ? selected : nav.presets[0].id);
    ready = true;
    stage.dataset.state = 'ready';
    $('loading').hidden = true;
    for (const id of ['room', 'reset', 'capture', 'lens', 'reset-lens']) $(id).disabled = false;
  } catch (error) { if (!disposed && !signal.aborted && error.name !== 'AbortError') failure(error); }
}
function updateLens() {
  lens = applyLens(camera, focalLength);
  const value = `${lens.focalLength.toFixed(1)} mm`;
  $('lens-value').textContent = `${lens.auto ? 'Auto · ' : ''}${value}`;
  $('lens').value = String(Math.min(70, Math.max(16, lens.focalLength)));
  $('lens').setAttribute('aria-valuetext', `${lens.auto ? 'Auto, ' : ''}${value}, 35 mm equivalent`);
}
function resize() {
  const { width, height } = stage.getBoundingClientRect();
  if (!renderer || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  updateLens();
}
function animate(time) {
  if (disposed) return;
  frame = requestAnimationFrame(animate);
  const dt = previous ? THREE.MathUtils.clamp((time - previous) / 1000, 0, .05) : 0;
  previous = time;
  if (document.hidden) return;
  if (stickPointer !== null && !stick.hasPointerCapture(stickPointer)) resetStick();
  if (ready) fixtureLighting.update(camera.position);
  if (ready) {
    const down = code => keys.has(code) ? 1 : 0;
    if (keys.size) {
      yaw += (down('KeyQ') - down('KeyE')) * dt * 1.3;
      pitch = THREE.MathUtils.clamp(pitch + (down('KeyR') - down('KeyF')) * dt, -1.35, 1.35);
      orientation();
    }
    const forward = down('KeyW') + down('ArrowUp') - down('KeyS') - down('ArrowDown') + stickInput[1];
    const sideways = down('KeyD') + down('ArrowRight') - down('KeyA') - down('ArrowLeft') + stickInput[0];
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
for (const id of ['ceiling-controls', 'ceiling-feedback']) {
  for (const type of ['pointerdown', 'focusin']) on($(id), type, clearInput);
}
on($('ceiling'), 'change', () => { clearInput(); ceilings?.select($('ceiling').value); });
on($('ceiling-retry'), 'click', () => { clearInput(); ceilings?.retry(); });
on($('quality'), 'click', () => {
  clearInput();
  if (ceilings) ceilings.select('sculpted', { quality: !ceilings.snapshot().qualityActive });
});
for (const type of ['pointerdown', 'focusin']) on($('lens-controls'), type, clearInput);
on($('lens'), 'input', () => {
  clearInput();
  focalLength = Number($('lens').value);
  updateLens();
});
on($('reset-lens'), 'click', () => {
  clearInput();
  focalLength = null;
  updateLens();
});
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
  document.body.classList.toggle('immersive', active);
  $('toggle-controls').hidden = !active;
  showControls(false);
  resize();
  if (ready) canvas.focus({ preventScroll: true });
});
function showControls(open) {
  release();
  const expanded = Boolean(document.fullscreenElement) && open;
  document.body.classList.toggle('controls-open', expanded);
  $('toggle-controls').setAttribute('aria-expanded', String(expanded));
  $('toggle-controls').textContent = expanded ? 'Hide controls' : 'Show controls';
}
on($('toggle-controls'), 'click', () => {
  const open = !document.body.classList.contains('controls-open');
  showControls(open);
  if (open) {
    help(false);
    $('room').focus({ preventScroll: true });
  } else {
    $('toggle-controls').focus({ preventScroll: true });
  }
});
function help(open) {
  release();
  $('instructions').hidden = !open;
  $('help').setAttribute('aria-expanded', String(open));
  if (open) {
    showControls(false);
    $('close-help').focus();
  } else if (document.fullscreenElement && !document.body.classList.contains('controls-open')) {
    $('toggle-controls').focus();
  } else {
    $('help').focus();
  }
}
on($('help'), 'click', () => help($('instructions').hidden));
on($('close-help'), 'click', () => help(false));
on($('capture'), 'click', async () => {
  if (document.pointerLockElement === canvas) { release(); return; }
  showControls(false);
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
  if (!ready || !$('instructions').hidden || event.button !== 0 || dragging) return;
  if (document.body.classList.contains('controls-open')) showControls(false);
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
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  on(canvas, type, event => { if (dragging?.id === event.pointerId) dragging = null; });
}
on(document, 'mousemove', event => {
  if (ready && document.pointerLockElement === canvas) look(event.movementX, event.movementY);
});
on(document, 'keydown', event => {
  if (event.code === 'Escape') {
    release();
    if (!$('instructions').hidden) help(false);
    if (document.body.classList.contains('controls-open')) {
      showControls(false);
      $('toggle-controls').focus({ preventScroll: true });
    }
    return;
  }
  if (!ready || !$('instructions').hidden || event.altKey || event.ctrlKey || event.metaKey) return;
  if ($('lens-controls').contains(event.target)) return;
  if (document.activeElement !== canvas && document.activeElement !== stick && document.pointerLockElement !== canvas) return;
  if (event.code === 'Space') {
    event.preventDefault();
    return;
  }
  if (movementKeys.has(event.code)) { event.preventDefault(); keys.add(event.code); }
});
on(document, 'keyup', event => keys.delete(event.code));
on(canvas, 'blur', event => { if (event.relatedTarget !== stick) clearInput(); });
on(stick, 'blur', event => { if (event.relatedTarget !== canvas) clearInput(); else keys.clear(); });
on(window, 'blur', release);
on(window, 'resize', release);
on(document, 'visibilitychange', () => { release(); previous = 0; });
on(document, 'pointerdown', event => {
  if (event.target.closest('header, footer, #instructions, .offline-panel')) clearInput();
});
on(document, 'focusin', event => {
  if (event.target.closest('header, footer, #instructions, .offline-panel')) clearInput();
});
function updateStick(event) {
  const x = event.clientX - stickOrigin.x, y = event.clientY - stickOrigin.y;
  stickInput = joystickVector(x, y);
  const extent = Math.max(40, Math.hypot(x, y));
  stick.firstElementChild.style.transform = `translate(${x / extent * 28}px, ${y / extent * 28}px)`;
}
on(stick, 'pointerdown', event => {
  if (!ready || !$('instructions').hidden || event.button !== 0 || stickPointer !== null) return;
  event.preventDefault();
  if (document.body.classList.contains('controls-open')) showControls(false);
  const rect = stick.getBoundingClientRect();
  stickOrigin = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  stickPointer = event.pointerId;
  stick.setPointerCapture(event.pointerId);
  stick.setAttribute('data-active', '');
  updateStick(event);
});
on(stick, 'pointermove', event => {
  if (event.pointerId !== stickPointer) return;
  if (!stick.hasPointerCapture(event.pointerId)) { resetStick(); return; }
  updateStick(event);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  on(stick, type, event => { if (event.pointerId === stickPointer) resetStick(); });
}
on(canvas, 'webglcontextlost', event => { event.preventDefault(); contextLost = true; failure(new Error('WebGL context was lost. Retry will reload this page.')); });
on(canvas, 'webglcontextrestored', () => location.reload());

function cleanup() {
  disposed = true; ready = false; release(); loadController?.abort();
  cancelAnimationFrame(frame); observer?.disconnect(); lifetime.abort();
  disposeModel(); fixtureLighting?.dispose(); renderer?.dispose();
}
on(window, 'pagehide', cleanup);
// A restored bfcache page needs a fresh renderer after pagehide disposal.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
// Read-only diagnostics used by the local browser regression suite.
window.walkthrough = { snapshot: () => ({
  ready, position: [...position], yaw, pitch, selected, currentRoom,
  safe: nav ? isSafe(nav, ...position) : false,
  pressed: keys.size + (stickPointer !== null ? 1 : 0), dragging: Boolean(dragging),
  joystick: { active: stickPointer !== null, sideways: stickInput[0], forward: stickInput[1] },
  triangles: renderer?.info.render.triangles, calls: renderer?.info.render.calls,
  memory: renderer ? { ...renderer.info.memory } : null, baseVisible: model?.visible,
  fov: camera?.fov, aspect: camera?.aspect, lens, eyeHeight: camera?.position.y,
  storage: { enabled: false, mode: 'closed' },
  fixtures: fixtureLighting?.snapshot(),
  ceiling: ceilings?.snapshot() || { selected: 'existing', pending: null, overlayLoaded: false, baselineHidden: false, unavailable: ceilingUnavailable },
}), geometrySnapshot: () => {
  const meshes = [];
  model?.traverse(obj => {
    if (obj.isMesh) meshes.push({ name: obj.name, matrix: obj.matrixWorld.toArray(), visible: obj.visible });
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
  fixtureLighting = createFixtureLighting(scene, {
    budget: window.matchMedia('(max-width: 700px), (pointer: coarse)').matches ? 4 : 8,
  });
  scene.background = new THREE.Color('#dce6eb');
  camera = new THREE.PerspectiveCamera(62, 1, .06, 80);
  scene.add(new THREE.HemisphereLight(0xf3f5ff, 0xc6b9a6, 2.1));
  const sun = new THREE.DirectionalLight(0xfff2de, 2.5);
  sun.position.set(5, 10, -8); sun.target.position.set(3, 0, -10);
  scene.add(sun, sun.target);
  observer = new ResizeObserver(resize); observer.observe(stage);
  resize(); frame = requestAnimationFrame(animate); load();
} catch (error) { failure(new Error(`WebGL initialization failed: ${error.message}`)); }
