import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { isSafe, move, movementVector, movementSpeed, joystickVector, roomAt, applyLens, inspectionNavigation } from './navigation.js?lens=1&controls=4';
import { validateCeilingOptions, activeCeilingOptions, createCeilingComparison, disposeCeiling } from './ceiling-comparison.js?v=a653fd99aa8b800d';
import { createFixtureLighting } from './fixture-lighting.js?v=07ea12a8efadecfe';
import { initBoardPlanning } from './electrical-board-planning.js?v=f631e2d32d862637';
import { createFurnitureVisibility } from './furniture-visibility.js';
import { loadHouseReview } from './house-review.js';

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
let stickPointer = null, stickKind = null, stickOrigin = null, stickInput = [0, 0];
let inputDiagnostics = false;
let inputNotice = '';
const inputTrace = [];
let fasterPace = false;
let renderer, scene, camera, model, nav, manifest, frame, previous = 0;
let yaw = 0, pitch = 0, ready = false, dragging = null, loadController, observer;
let selected = 'kitchen', position = [0, 0], disposed = false, blocked = false, contextLost = false;
let currentRoom = '';
let focalLength = null, lens;
let ceilings, ceilingOptions, ceilingUnavailable = '';
let fixtureLighting;
let electrical;
let furniture, furnitureController, furnitureRequest = 0;
let houseReview, eyeHeight = 1.6;
let electricalAccessories, accessoryController, accessoryRequest = 0, accessoryError = '';
const STARTUP_VIEW = Object.freeze({ ceiling: 'luxe', electricalPlates: true, timeoutMs: 15000 });
let ceilingRequest = Promise.resolve();
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE', 'KeyR', 'KeyF']);
on($('accessory-retry'), 'click', () => {
  if (loadController && !loadController.signal.aborted) loadAccessories(loadController.signal);
});
const shiftHeld = () => keys.has('ShiftLeft') || keys.has('ShiftRight');
function renderPace() {
  const fast = fasterPace || shiftHeld();
  $('pace').textContent = `Pace: ${fast ? 'Faster' : 'Walk'}${shiftHeld() && !fasterPace ? ' (Shift)' : ''}`;
  $('pace').setAttribute('aria-pressed', String(fast));
}
function clearKeys() {
  keys.clear();
  renderPace();
}
function ownsPointer(id, kind, event) {
  return id === event.pointerId && (!event.pointerType || event.pointerType === kind);
}
function traceInput(action, event, role) {
  if (!inputDiagnostics) return;
  inputTrace.push({ action, role, type: event?.pointerType || 'none', id: event?.pointerId ?? null });
  if (inputTrace.length > 20) inputTrace.shift();
  $('input-diagnostics-log').textContent = inputTrace.map(item =>
    `${item.role}: ${item.action} (${item.type}${item.id === null ? '' : ` #${item.id}`})`).join('\n');
}

function clearInput() {
  clearKeys();
  resetStick();
  const pointer = dragging?.id;
  dragging = null;
  if (pointer !== undefined && canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
}
function resetStick() {
  const pointer = stickPointer;
  stickPointer = null; stickKind = null; stickOrigin = null; stickInput = [0, 0];
  stick.firstElementChild.style.transform = '';
  stick.removeAttribute('data-active');
  keys.delete('ShiftLeft'); keys.delete('ShiftRight'); renderPace();
  if (pointer !== null && stick.hasPointerCapture(pointer)) stick.releasePointerCapture(pointer);
}
function release() {
  clearInput();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}
function message(text) { inputNotice = ''; status.textContent = text; }
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
  eyeHeight = 1.6; renderHeight();
  camera.position.set(position[0], eyeHeight, -position[1]);
  orientation();
  room.value = id;
  blocked = false;
  currentRoom = id;
  message(`${preset.name} · eye height 1.6 m`);
}
function disposeModel() {
  ++furnitureRequest; furnitureController?.abort(); furnitureController = null;
  furniture?.dispose(); furniture = null;
  houseReview?.dispose(); houseReview = null;
  $('furniture').disabled = true;
  $('furniture').checked = true;
  $('furniture-mode').disabled = true;
  $('furniture-mode').value = 'solid';
  $('furniture-alert').hidden = true; $('furniture-retry').hidden = true;
  ++accessoryRequest; accessoryController?.abort(); accessoryController = null;
  electricalAccessories?.dispose(); electricalAccessories = null; accessoryError = '';
  $('accessory-alert').hidden = true; $('accessory-retry').hidden = true;
  electrical?.dispose(); electrical = null;
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
async function loadFurniture(signal) {
  const ticket = ++furnitureRequest;
  furnitureController?.abort();
  $('furniture-retry').disabled = true;
  const source = model;
  const controller = furnitureController = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Furniture inspection loading timed out')), 15000);
  try {
    const bytes = await (await checkedFetch('./model/furniture-visibility.json', controller.signal)).arrayBuffer();
    await verifyHash(bytes, manifest.furniture_visibility_sha256, 'Furniture visibility data');
    const mask = JSON.parse(new TextDecoder().decode(bytes));
    if (signal.aborted || source !== model || ticket !== furnitureRequest || disposed) return;
    if (controller.signal.aborted) throw controller.signal.reason;
    furniture?.dispose();
    furniture = createFurnitureVisibility(THREE, model, mask, manifest.model_sha256);
    furniture.setMode($('furniture-mode').value);
    houseReview?.setFurnitureMode($('furniture-mode').value);
    $('furniture').disabled = false;
    $('furniture-mode').disabled = false;
    electrical?.refreshOccluders();
    $('furniture-alert').hidden = true;
    $('furniture-retry').hidden = true;
  } catch (error) {
    if (!signal.aborted && source === model && ticket === furnitureRequest && !disposed) {
      $('furniture-alert').textContent = `${error.message} Furniture inspection is unavailable; the furnished house remains unchanged.`;
      $('furniture-alert').hidden = false;
      $('furniture-retry').hidden = false;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (ticket === furnitureRequest) $('furniture-retry').disabled = false;
  }
}
async function loadAccessories(signal) {
  const source = manifest;
  const ticket = ++accessoryRequest;
  accessoryController?.abort();
  const controller = accessoryController = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Accessory loading timed out')), STARTUP_VIEW.timeoutMs);
  $('accessory-retry').disabled = true;
  try {
    const { loadElectricalAccessories } = await import('./electrical-accessories.js?v=d26bff5cb160507f');
    const loaded = await loadElectricalAccessories({
      THREE, scene, house: source, baseURL: document.baseURI,
      parse: bytes => new GLTFLoader().parseAsync(bytes, ''),
      fetchAsset: (url, options) => fetch(url, { ...options, signal: controller.signal }),
    });
    if (disposed || signal.aborted || ticket !== accessoryRequest || source !== manifest) { loaded.dispose(); return; }
    if (controller.signal.aborted) { loaded.dispose(); throw controller.signal.reason; }
    electricalAccessories?.dispose();
    electricalAccessories = loaded; accessoryError = '';
    $('accessory-alert').hidden = true; $('accessory-retry').hidden = true;
  } catch (error) {
    if (disposed || signal.aborted || ticket !== accessoryRequest || source !== manifest) return;
    accessoryError = `Bedside shelves and dry mirror-light provisions unavailable: ${error.message}. They are not shown; walking and switchboards remain available.`;
    $('accessory-alert').textContent = accessoryError;
    $('accessory-alert').hidden = false; $('accessory-retry').hidden = false;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (ticket === accessoryRequest) $('accessory-retry').disabled = false;
  }
}
function selectCeiling(id, options) {
  ceilingRequest = ceilings ? ceilings.select(id, options) : Promise.resolve();
  return ceilingRequest;
}
function disposeCeilings() {
  ceilings?.dispose(); ceilings = null; ceilingOptions = null; ceilingUnavailable = '';
  ceilingRequest = Promise.resolve();
  $('ceiling-alert').hidden = true;
  $('ceiling-alert').textContent = '';
  for (const id of ['ceiling-controls', 'ceiling-feedback', 'ceiling-help', 'quality']) $(id).hidden = true;
  document.querySelector('header').classList.remove('has-ceilings');
}
function renderCeilings(state) {
  const variant = state.qualityActive ? ceilingOptions?.quality : ceilingOptions?.variants.find(v => v.id === state.selected);
  const pending = state.pendingQuality ? ceilingOptions?.quality : ceilingOptions?.variants.find(v => v.id === state.pending);
  $('ceiling').value = state.pending || state.selected;
  $('ceiling').setAttribute('aria-busy', String(Boolean(state.pending)));
  $('ceiling-status').textContent = state.error || (pending
    ? `Loading ${pending.label}… Still showing ${variant?.label || 'the base model'}.`
    : 'Historical ceiling visualization only. Designer to finalize; not the basis for switch/module counts.');
  $('ceiling-feedback').dataset.error = String(Boolean(state.error));
  $('ceiling-alert').hidden = !state.error;
  $('ceiling-alert').textContent = state.error ? `${state.error} Open Settings for ceiling recovery.` : '';
  $('ceiling-retry').hidden = !state.failed;
  $('quality').hidden = !ceilingOptions?.quality || state.selected !== 'sculpted';
  $('quality').disabled = Boolean(state.pending);
  $('quality').setAttribute('aria-pressed', String(state.qualityActive));
  $('quality').textContent = state.pendingQuality ? 'Loading baked preview…' : state.qualityActive ? 'Use standard lighting' : 'Try baked lighting';
}
function setupCeilings() {
  try {
    ceilingOptions = activeCeilingOptions(validateCeilingOptions(manifest, document.baseURI));
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
    $('ceiling').replaceChildren(
      ...(ceilingOptions.version === 4 ? [] : [new Option('Existing', 'existing')]),
      ...ceilingOptions.variants.map(v => new Option(v.id === 'luxe' ? 'Luxe · historical only' : v.label, v.id)));
    $('ceiling').disabled = ceilingOptions.version === 4;
    $('ceiling-note').textContent = ceilingOptions.note;
    for (const id of ['ceiling-controls', 'ceiling-feedback', 'ceiling-help']) $(id).hidden = false;
    document.querySelector('header').classList.add('has-ceilings');
    renderCeilings(ceilings.snapshot());
  } catch (error) {
    ceilingUnavailable = `${error.message} Showing the base model; the historical ceiling preview is unavailable. Walking is unchanged.`;
    $('ceiling-feedback').hidden = false;
    $('ceiling-feedback').dataset.error = 'true';
    $('ceiling-status').textContent = ceilingUnavailable;
    $('ceiling-alert').textContent = ceilingUnavailable;
    $('ceiling-alert').hidden = false;
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
    const inspectionBytes = await (await checkedFetch(
      `./model/inspection.json?v=${manifest.inspection_navigation_sha256}`, signal)).arrayBuffer();
    await verifyHash(inspectionBytes, manifest.inspection_navigation_sha256, 'Inspection navigation');
    const inspection = JSON.parse(new TextDecoder().decode(inspectionBytes));
    if (inspection.base_navigation_sha256 !== manifest.navigation_sha256 ||
        inspection.step !== nav.step || inspection.width !== nav.width || inspection.height !== nav.height ||
        JSON.stringify(inspection.origin) !== JSON.stringify(nav.origin)) {
      throw new Error('Inspection navigation does not match this house.');
    }
    nav.inspection_cells = inspection.cells;
    nav = inspectionNavigation(nav);
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
    try {
      houseReview = await loadHouseReview({ THREE, model, scene, house: manifest, signal });
      $('house-review-alert').hidden = true;
    } catch (error) {
      if (signal.aborted || disposed) return;
      $('house-review-alert').textContent = `Rear TV, separate phone outlets and lower glass panels are not shown: ${error.message}. Reload to retry; the base house remains available.`;
      $('house-review-alert').hidden = false;
    }
    const furnitureReady = loadFurniture(signal);
    fixtureLighting.setRooms(nav.rooms);
    fixtureLighting.register(model);
    setupCeilings();
    if (ceilingOptions?.variants.some(variant => variant.id === STARTUP_VIEW.ceiling)) {
      selectCeiling(STARTUP_VIEW.ceiling);
    }
    electrical = initBoardPlanning({
      THREE, scene, camera, stage, model, container: document.querySelector('[data-electrical-host]'),
      houseDescriptor: manifest, releaseInput: clearInput, initialPlates: STARTUP_VIEW.electricalPlates,
      reviewDescriptor: houseReview?.data || null,
      reviewRoot: houseReview?.root || null,
      setJoineryServiceOpen: value => houseReview?.setServiceOpen(value),
      isInputBusy: () => stickPointer !== null || Boolean(dragging) || keys.size > 0 || document.pointerLockElement === canvas,
      revealControls: () => showControls(true),
      inspectSocket: (target, normal, roomID, label, mode = 'socket') => {
        const distances = mode === 'equipment' ? [2, 1.8, 1.5, 1.2] : mode === 'panel' ? [1.2, 1, .8] :
          /^bedroom_[13]$/.test(roomID) ? [.6, .8, 1, 1.2] : [.8, .6, 1, 1.2];
        const candidates = distances.flatMap(distance => (mode === 'panel' ? [-.3, 0, .3] : [0, .3, -.3, .55, -.55]).map(side => [
          target[0] + normal[0] * distance - normal[2] * side,
          -target[2] - normal[2] * distance - normal[0] * side,
        ])).filter(point => isSafe(nav, ...point) && roomAt(nav, point)?.id === roomID);
        model.updateWorldMatrix(true, true);
        const visibleFrom = point => {
          const eye = new THREE.Vector3(point[0], 1.6, -point[1]);
          const direction = new THREE.Vector3(...target).sub(eye);
          const ray = new THREE.Raycaster(eye, direction.clone().normalize(), 0, direction.length() - .04);
          return !ray.intersectObjects([model, ...(houseReview ? [houseReview.root] : [])], true).some(hit => {
            const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face?.materialIndex || 0] : hit.object.material;
            return hit.object.visible && material?.visible !== false && !(material?.transparent && material.opacity < .5);
          });
        };
        const clearDestination = candidates.find(visibleFrom);
        const destination = clearDestination || candidates[0];
        if (!destination) throw new Error('No safe close-up position in this room. Use the room menu and Look at device instead.');
        release(); position = destination; selected = roomID; room.value = roomID; blocked = false;
        eyeHeight = 1.6; renderHeight();
        camera.position.set(position[0], 1.6, -position[1]);
        const dx = target[0] - position[0], dy = -target[2] - position[1];
        yaw = Math.atan2(-dx, dy);
        pitch = THREE.MathUtils.clamp(Math.atan2(target[1] - eyeHeight, Math.hypot(dx, dy)), -1.35, 1.35);
        focalLength = mode === 'equipment' ? 30 : mode === 'panel' ? 35 : 45; updateLens(); orientation(); showControls(false);
        message(`${label} · ${mode === 'equipment' ? 'equipment view' : 'plug close-up'} · 1.6 m eye height${clearDestination ? '' : ' · View obscured: use Transparent furniture'} · Reset lens restores a wider view`);
      },
      aimAt: target => {
        release();
        const dx = target[0] - position[0], dy = -target[2] - position[1];
        yaw = Math.atan2(-dx, dy);
        pitch = THREE.MathUtils.clamp(Math.atan2(target[1] - eyeHeight, Math.hypot(dx, dy)), -1.35, 1.35);
        orientation(); showControls(false);
      },
    });
    // The GLB contains the authored closed pose. Do not instantiate animation,
    // picking or dynamic collision controllers in this stability fallback.
    room.replaceChildren(...nav.presets.map(p => new Option(p.name, p.id)));
    teleport(nav.presets.some(p => p.id === selected) ? selected : nav.presets[0].id);
    const previewCord = new URL(location.href).searchParams.get('cord');
    if (previewCord) electrical.ready.then(() => {
      if (disposed || signal.aborted || !electrical?.snapshot().physicalLeads?.loaded) return;
      try { electrical.inspectCord(previewCord); }
      catch (cause) { message(`Cord close-up unavailable: ${cause.message}`); }
    });
    $('loading-detail').textContent = 'Preparing Sculpted Luxe and proposed switchboards…';
    const initialElectrical = electrical;
    const accessoriesReady = initialElectrical.ready.then(() => {
      if (!disposed && !signal.aborted && initialElectrical.revision() === 'electrical-v004') return loadAccessories(signal);
    });
    let startupTimer;
    const optionalReady = async () => {
      await Promise.all([initialElectrical.ready, accessoriesReady, furnitureReady]);
      let awaited;
      do {
        awaited = ceilingRequest;
        await awaited;
      } while (awaited !== ceilingRequest && !signal.aborted);
    };
    try {
      await Promise.race([optionalReady(), new Promise(resolve => {
        startupTimer = setTimeout(() => {
          if (!signal.aborted && !disposed) {
            ceilings?.cancelPending('Initial ceiling loading timed out.');
            initialElectrical.cancelPending('Initial electrical loading timed out.');
          }
          resolve();
        }, STARTUP_VIEW.timeoutMs);
      })]);
    } finally { clearTimeout(startupTimer); }
    if (disposed || signal.aborted) return;
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
  stage.style.setProperty('--viewer-footer-height', `${document.querySelector('footer').getBoundingClientRect().height}px`);
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
  if (stickPointer !== null && !stick.hasPointerCapture(stickPointer)) {
    traceInput('capture-missing', { pointerId: stickPointer, pointerType: stickKind }, 'move');
    resetStick();
  }
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
    const [dx, dy] = movementVector(forward, sideways, yaw, dt, movementSpeed(fasterPace, shiftHeld()));
    const next = move(nav, position, dx, dy);
    const hit = Math.hypot(dx, dy) > 0 && Math.hypot(next[0] - position[0], next[1] - position[1]) < Math.hypot(dx, dy) * .2;
    const location = roomAt(nav, next);
    if (!inputNotice && hit && !blocked) message('Wall or floor boundary · turn or sidestep. Furniture is pass-through.');
    if (!inputNotice && !hit && (blocked || currentRoom !== location?.id)) message(`${location?.name || 'Passage'} · view height ${eyeHeight.toFixed(2)} m`);
    currentRoom = location?.id;
    blocked = hit;
    position = next;
    camera.position.set(position[0], eyeHeight, -position[1]);
  }
  electrical?.update({ time, currentRoom, paused: !ready || !$('instructions').hidden ||
    document.body.classList.contains('controls-open') || document.pointerLockElement === canvas });
  renderer.render(scene, camera);
}

on($('retry'), 'click', () => renderer && !contextLost ? load() : location.reload());
on(room, 'change', () => teleport(room.value));
function renderHeight() {
  $('view-height').textContent = `${eyeHeight.toFixed(2)} m`;
  $('rise').disabled = eyeHeight >= 2.75;
  $('lower').disabled = eyeHeight <= .35;
}
function changeHeight(delta) {
  if (!ready) return;
  release();
  eyeHeight = THREE.MathUtils.clamp(Math.round((eyeHeight + delta) * 100) / 100, .35, 2.75);
  camera.position.y = eyeHeight; renderHeight();
  message(`Inspection height ${eyeHeight.toFixed(2)} m · walls still block horizontal travel · not stair climbing`);
}
on($('rise'), 'click', () => changeHeight(.25));
on($('lower'), 'click', () => changeHeight(-.25));
on($('eye-level'), 'click', () => changeHeight(1.6 - eyeHeight));
on($('reset'), 'click', () => teleport(selected));
on($('furniture'), 'change', () => {
  clearInput();
  $('furniture-mode').value = $('furniture').checked ? 'solid' : 'hidden';
  furniture?.setMode($('furniture-mode').value);
  houseReview?.setFurnitureMode($('furniture-mode').value);
  electrical?.refreshOccluders();
});
on($('furniture-mode'), 'change', () => {
  clearInput();
  furniture?.setMode($('furniture-mode').value);
  houseReview?.setFurnitureMode($('furniture-mode').value);
  $('furniture').checked = $('furniture-mode').value !== 'hidden';
  electrical?.refreshOccluders();
});
on($('furniture-retry'), 'click', () => {
  if (loadController && !loadController.signal.aborted) loadFurniture(loadController.signal);
});
on($('pace'), 'click', () => {
  clearInput();
  fasterPace = !fasterPace;
  renderPace();
  if (ready) canvas.focus({ preventScroll: true });
});
for (const id of ['ceiling-controls', 'ceiling-feedback']) {
  for (const type of ['pointerdown', 'focusin']) on($(id), type, clearInput);
}
on($('ceiling'), 'change', () => { clearInput(); selectCeiling($('ceiling').value); });
on($('ceiling-retry'), 'click', () => { clearInput(); ceilingRequest = ceilings?.retry() || Promise.resolve(); });
on($('quality'), 'click', () => {
  clearInput();
  if (ceilings) selectCeiling('sculpted', { quality: !ceilings.snapshot().qualityActive });
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
  showControls(false);
  resize();
  if (ready) canvas.focus({ preventScroll: true });
});
function showControls(open) {
  release();
  if (open) document.body.classList.remove('phone-exploring');
  const expanded = open;
  document.body.classList.toggle('controls-open', expanded);
  $('toggle-controls').setAttribute('aria-expanded', String(expanded));
  $('toggle-controls').textContent = expanded ? 'Close settings' : 'Settings';
}
on($('toggle-controls'), 'click', () => {
  const open = !document.body.classList.contains('controls-open');
  showControls(open);
  if (open) {
    help(false);
    $('close-settings').focus({ preventScroll: true });
  } else {
    $('toggle-controls').focus({ preventScroll: true });
  }
});
on($('close-settings'), 'click', () => {
  showControls(false);
  $('toggle-controls').focus({ preventScroll: true });
});
on($('restore-controls'), 'click', () => {
  release();
  document.body.classList.remove('phone-exploring');
  $('toggle-controls').focus({ preventScroll: true });
});
function help(open) {
  release();
  $('instructions').hidden = !open;
  $('help').setAttribute('aria-expanded', String(open));
  if (open) {
    showControls(false);
    $('close-help').focus();
  } else if (!document.body.classList.contains('controls-open')) {
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
  // Suppress compatibility mouse/default focus gestures for pen/touch contacts.
  // Keyboard focus is not ownership of either independently captured pointer.
  if (event.pointerType === 'pen' || event.pointerType === 'touch') event.preventDefault();
  if (document.body.classList.contains('controls-open')) showControls(false);
  if (stickPointer === null || event.pointerType === 'mouse') canvas.focus({ preventScroll: true });
  if (document.pointerLockElement !== canvas) {
    dragging = { id: event.pointerId, kind: event.pointerType, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, startedAt: performance.now(),
      label: electrical?.pickLabel(event.clientX, event.clientY) || null };
    canvas.setPointerCapture(event.pointerId);
    traceInput('start', event, 'look');
  }
});
on(canvas, 'pointermove', event => {
  if (!dragging || !ownsPointer(dragging.id, dragging.kind, event)) return;
  if (event.pointerType === 'pen' && !(event.buttons & 1)) {
    dragging.label = null;
    dragging.x = event.clientX; dragging.y = event.clientY;
    return;
  }
  if (dragging.label) {
    if (Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 6 && !(event.buttons & ~1)) return;
    dragging.label = null;
  }
  look(event.clientX - dragging.x, event.clientY - dragging.y);
  dragging.x = event.clientX; dragging.y = event.clientY;
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  on(canvas, type, event => {
    if (!dragging || !ownsPointer(dragging.id, dragging.kind, event)) return;
    traceInput(type, event, 'look');
    const label = type === 'pointerup' && event.button === 0 && stickPointer === null && keys.size === 0 &&
      performance.now() - dragging.startedAt <= 500 &&
      Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) < 6 ? dragging.label : null;
    dragging = null;
    if (type !== 'pointerup') {
      keys.delete('ShiftLeft'); keys.delete('ShiftRight'); renderPace();
    }
    if (label) electrical?.selectLabel(label);
  });
}
on(canvas, 'contextmenu', event => {
  if (event.pointerType === 'pen' || dragging?.kind === 'pen') event.preventDefault();
});
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
  if (event.code === 'PageUp' || event.code === 'PageDown') {
    event.preventDefault(); changeHeight(event.code === 'PageUp' ? .25 : -.25); return;
  }
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    keys.add(event.code); renderPace(); return;
  }
  if (movementKeys.has(event.code)) {
    event.preventDefault();
    if (dragging) dragging.label = null;
    keys.add(event.code);
  }
});
on(document, 'keyup', event => { keys.delete(event.code); renderPace(); });
// Element focus can change during pen use without ending the finger stream.
// Real window/app loss and focus entering controls still release all inputs.
for (const element of [canvas, stick]) on(element, 'blur', event => {
  traceInput('element-blur (keys only)', event, 'focus');
  clearKeys();
});
on(window, 'blur', event => { traceInput('window-blur', event, 'all'); release(); });
on(window, 'resize', event => { traceInput('resize', event, 'all'); release(); });
on(document, 'visibilitychange', event => { traceInput('visibilitychange', event, 'all'); release(); previous = 0; });
on(document, 'pointerdown', event => {
  if (event.target.closest('header, footer, #walkthrough-controls, #instructions, .offline-panel, .electrical-planning')) {
    traceInput('control interaction', event, 'all'); clearInput();
  }
});
on(document, 'focusin', event => {
  if (event.target.closest('header, footer, #walkthrough-controls, #instructions, .offline-panel, .electrical-planning')) {
    traceInput('control focus', event, 'all'); clearInput();
  }
});
on($('input-diagnostics'), 'click', () => {
  inputDiagnostics = !inputDiagnostics;
  inputTrace.length = 0;
  $('input-diagnostics').setAttribute('aria-pressed', String(inputDiagnostics));
  $('input-diagnostics-log').hidden = !inputDiagnostics;
  $('input-diagnostics-log').textContent = inputDiagnostics
    ? 'Recording on this page only. Close Help, try finger + pen, then reopen Help to read the last 20 events.'
    : '';
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
  if (dragging) dragging.label = null;
  if (document.body.classList.contains('controls-open')) showControls(false);
  if (matchMedia('(any-pointer: coarse), (max-width: 700px)').matches) {
    document.body.classList.add('phone-exploring');
  }
  const rect = stick.getBoundingClientRect();
  stickOrigin = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  stickPointer = event.pointerId;
  stickKind = event.pointerType;
  stick.setPointerCapture(event.pointerId);
  stick.setAttribute('data-active', '');
  if (inputNotice) message('Movement resumed · drag to look');
  updateStick(event);
  traceInput('start', event, 'move');
});
on(stick, 'pointermove', event => {
  if (!ownsPointer(stickPointer, stickKind, event)) return;
  if (!stick.hasPointerCapture(event.pointerId)) { traceInput('capture-missing', event, 'move'); resetStick(); return; }
  updateStick(event);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  on(stick, type, event => {
    if (!ownsPointer(stickPointer, stickKind, event)) return;
    traceInput(type, event, 'move');
    const touchCancelled = type === 'pointercancel' && stickKind === 'touch';
    resetStick();
    if (touchCancelled) {
      inputNotice = 'Finger input cancelled · see Help';
      status.textContent = inputNotice;
    }
  });
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
  pointers: { move: stickPointer === null ? null : { id: stickPointer, type: stickKind },
    look: dragging ? { id: dragging.id, type: dragging.kind } : null,
    diagnostics: inputDiagnostics ? inputTrace.map(item => ({ ...item })) : [] },
  pace: { faster: fasterPace, shift: shiftHeld(), speed: movementSpeed(fasterPace, shiftHeld()) },
  triangles: renderer?.info.render.triangles, calls: renderer?.info.render.calls,
  memory: renderer ? { ...renderer.info.memory } : null, baseVisible: model?.visible,
  fov: camera?.fov, aspect: camera?.aspect, lens, eyeHeight: camera?.position.y,
  storage: { enabled: false, mode: 'closed' },
  furniture: furniture?.snapshot() || null,
  houseReview: houseReview?.snapshot() || null,
  fixtures: fixtureLighting?.snapshot(),
  electrical: electrical?.snapshot() || null,
  accessories: { loaded: Boolean(electricalAccessories), error: accessoryError,
    count: electricalAccessories?.descriptor.provisions.length || 0 },
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
  observer = new ResizeObserver(resize); observer.observe(stage); observer.observe(document.querySelector('footer'));
  resize(); frame = requestAnimationFrame(animate); load();
} catch (error) { failure(new Error(`WebGL initialization failed: ${error.message}`)); }
