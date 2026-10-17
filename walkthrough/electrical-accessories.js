import { assertEmbeddedGLB, disposeCeiling } from './ceiling-comparison.js?v=a653fd99aa8b800d';

const HASH = /^[a-f0-9]{64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const vector = value => Array.isArray(value) && value.length === 3 &&
  value.every(n => Number.isFinite(n) && Math.abs(n) <= 100);
const IDS = new Set(['B2-A', 'B2-B', 'B1-MIRROR', 'B2-MIRROR', 'B3-MIRROR']);

export function validateElectricalAccessories(value, house, baseURL) {
  const fail = () => { throw new Error('Invalid source-bound electrical accessory provisions'); };
  if (!exact(value, ['version', 'id', 'base_source_sha256', 'model', 'provisions', 'limits']) ||
      value.version !== 1 || value.id !== 'electrical-v004-accessories' ||
      !HASH.test(value.base_source_sha256) || value.base_source_sha256 !== house.source_sha256 ||
      !exact(value.model, ['src', 'sha256', 'bytes']) || !HASH.test(value.model.sha256) ||
      !Number.isSafeInteger(value.model.bytes) || value.model.bytes < 20 || value.model.bytes > 1_000_000 ||
      value.model.src !== `./model/electrical/accessories-${value.model.sha256.slice(0, 16)}.glb` ||
      !Array.isArray(value.provisions) || value.provisions.length !== 5 ||
      !Array.isArray(value.limits) || value.limits.length > 10 ||
      !value.limits.every(line => typeof line === 'string' && line.length > 0 && line.length <= 500)) fail();
  const seen = new Set();
  for (const item of value.provisions) {
    const mirror = item.id?.endsWith('-MIRROR');
    if (!exact(item, mirror ? ['id', 'room', 'center_m', 'size_m', 'status'] : ['id', 'center_m', 'size_m']) ||
        !IDS.has(item.id) || seen.has(item.id) || !vector(item.center_m) || !vector(item.size_m) ||
        item.size_m.some(n => n <= 0 || n > 1) ||
        (mirror && (!['bedroom_1', 'bedroom_2', 'bedroom_3'].includes(item.room) ||
                    item.status !== 'dry task-light reservation'))) fail();
    seen.add(item.id);
  }
  const base = new URL(baseURL), url = new URL(value.model.src, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(new URL('./model/electrical/', base).pathname)) fail();
  return { ...structuredClone(value), model: { ...value.model, url: url.href } };
}

// Caller chooses visibility with the electrical proposal; no changes to walking,
// navigation, collisions, source house, ceiling choice or live electrical state.
export async function loadElectricalAccessories({ THREE, scene, house, baseURL = document.baseURI,
  parse, fetchAsset = fetch, digest = bytes => crypto.subtle.digest('SHA-256', bytes) }) {
  let root = null;
  try {
    const response = await fetchAsset(new URL('./model/electrical/accessories.json', baseURL),
      { cache: 'no-store', redirect: 'error', credentials: 'omit' });
    if (!response.ok) throw new Error(`Accessory definitions HTTP ${response.status}`);
    const descriptor = validateElectricalAccessories(await response.json(), house, baseURL);
    const asset = await fetchAsset(descriptor.model.url,
      { cache: 'no-store', redirect: 'error', credentials: 'omit' });
    if (!asset.ok) throw new Error(`Accessory model HTTP ${asset.status}`);
    const bytes = await asset.arrayBuffer();
    const hash = [...new Uint8Array(await digest(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== descriptor.model.sha256 || bytes.byteLength !== descriptor.model.bytes) throw new Error('Accessory integrity mismatch');
    assertEmbeddedGLB(bytes);
    root = (await parse(bytes)).scene;
    if (!root) throw new Error('Accessory scene missing');
    root.updateMatrixWorld(true);
    const allowed = new Set(descriptor.provisions.map(item => `PROVISION_${item.id}`));
    root.traverse(node => {
      if (node.isLight || node.isCamera || (node.isMesh && !allowed.has(node.name))) {
        throw new Error('Unexpected accessory content');
      }
    });
    for (const item of descriptor.provisions) {
      const matches = [];
      root.traverse(node => { if (node.name === `PROVISION_${item.id}`) matches.push(node); });
      const expected = new THREE.Vector3(item.center_m[0], item.center_m[2], -item.center_m[1]);
      if (matches.length !== 1 || !new THREE.Box3().setFromObject(matches[0]).expandByScalar(.002).containsPoint(expected)) {
        throw new Error('Accessory position binding mismatch');
      }
    }
    root.name = 'Provisional compact shelves and dry mirror task-light reservations';
    scene.add(root);
    return { root, descriptor, setEnabled: enabled => { root.visible = Boolean(enabled); },
      dispose: () => { scene.remove(root); disposeCeiling(root); } };
  } catch (error) {
    if (root) { scene.remove(root); disposeCeiling(root); }
    throw error;
  }
}
