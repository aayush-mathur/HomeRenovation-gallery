import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#model');
const fallback = document.querySelector('#fallback');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const interior = document.querySelector('#interior');
const buttons = [...document.querySelectorAll('[data-view]')];
const views = {
  front: { at: [2.30, 2.70, 3.70], target: [1, 1, -1.35] },
  window: { at: [2.7, 1.6, -.10], target: [0, 1.35, -.95] },
  plan: { at: [1.1, 5.3, -1.099], target: [1.1, 0, -1.1] },
};
let renderer, scene, camera, model, hiddenFronts = false, loading = false;
let activeView = 'front';

function render() {
  if (!renderer || !camera) return;
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}

function setView(id) {
  activeView = id;
  if (!camera) return;
  camera.position.fromArray(views[id].at);
  camera.lookAt(new THREE.Vector3().fromArray(views[id].target));
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.view === id));
  render();
}

function setFronts() {
  if (!model) return;
  model.traverse(node => {
    if (/closed_door|recessed_grip|closed door|recessed grip/.test(node.name)) node.visible = !hiddenFronts;
  });
  interior.setAttribute('aria-pressed', String(hiddenFronts));
  interior.textContent = hiddenFronts ? 'Restore closed storage' : 'Inspect inside storage';
  status.textContent = hiddenFronts
    ? 'Inspection cutaway: fronts hidden, not opened into the route. Empty ladder bay awaits actual folded dimensions.'
    : 'Landing v001 loaded. Independent intermediate-level study; not a connected stair route.';
  render();
}

async function load() {
  if (loading) return;
  loading = true;
  retry.hidden = true;
  for (const button of [...buttons, interior]) button.disabled = true;
  status.textContent = 'Loading and verifying the independent landing model...';
  try {
    const response = await fetch('./manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.version !== 1 || manifest.id !== 'landing-v001' || manifest.connected_to_house !== false ||
        !/^landing-[a-f0-9]{16}\.glb$/.test(manifest.model) ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Unrecognized landing binding');
    const asset = await fetch(`./${manifest.model}`);
    if (!asset.ok) throw new Error(`Model HTTP ${asset.status}`);
    const data = await asset.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.sha256 || data.byteLength !== manifest.bytes) throw new Error('Model integrity mismatch');
    const gltf = await new GLTFLoader().parseAsync(data, '');
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#e3e2da');
      camera = new THREE.PerspectiveCamera(46, 1, .05, 30);
      scene.add(new THREE.HemisphereLight(0xf2f4ef, 0x8a9385, 2));
      const light = new THREE.DirectionalLight(0xfff2dc, 2.2);
      light.position.set(1, 4, 3);
      scene.add(light);
    }
    if (model) {
      scene.remove(model);
      model.traverse(node => {
        node.geometry?.dispose();
        for (const material of (Array.isArray(node.material) ? node.material : [node.material])) material?.dispose();
      });
    }
    model = gltf.scene;
    scene.add(model);
    canvas.hidden = false;
    fallback.hidden = true;
    setView(activeView);
    setFronts();
    canvas.dataset.loaded = manifest.id;
    canvas.dataset.modelHash = hash;
  } catch (error) {
    canvas.hidden = true;
    fallback.hidden = false;
    status.textContent = `3D unavailable: ${error.message}. The rendered preview and dimensioned plan remain available.`;
    retry.hidden = false;
  } finally {
    loading = false;
    for (const button of [...buttons, interior]) button.disabled = !model || canvas.hidden;
  }
}

for (const button of buttons) button.addEventListener('click', () => setView(button.dataset.view));
interior.addEventListener('click', () => { hiddenFronts = !hiddenFronts; setFronts(); });
retry.addEventListener('click', load);
new ResizeObserver(render).observe(stage);
load();
