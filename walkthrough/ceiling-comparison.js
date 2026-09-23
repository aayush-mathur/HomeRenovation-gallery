const HASH = /^[a-f0-9]{64}$/;
const IDS = {
  1: ['quiet', 'linear', 'warm'],
  2: ['quiet', 'linear', 'warm', 'sculpted'],
};

export function validateCeilingOptions(manifest, baseURL) {
  if (manifest.ceiling_options === undefined) return null;
  const options = manifest.ceiling_options;
  const invalid = detail => { throw new Error(`Ceiling comparison unavailable: ${detail}.`); };
  if (!options || !Number.isInteger(options.version) || !Object.hasOwn(IDS, options.version) ||
      options.default !== 'existing') invalid('unsupported descriptor');
  const ids = IDS[options.version];
  if (!HASH.test(manifest.source_sha256) || options.base_source_sha256 !== manifest.source_sha256) invalid('source binding does not match this house');
  if (!Array.isArray(options.baseline_nodes) || !options.baseline_nodes.length ||
      options.baseline_nodes.some(name => typeof name !== 'string' || !name.trim()) ||
      new Set(options.baseline_nodes).size !== options.baseline_nodes.length) invalid('invalid baseline node names');
  if (!Array.isArray(options.variants) || options.variants.length !== ids.length ||
      new Set(options.variants.map(v => v?.id)).size !== ids.length) invalid(`${ids.length} distinct schemes are required`);
  const base = new URL(baseURL);
  const variants = options.variants.map(variant => {
    if (!variant || !ids.includes(variant.id) || typeof variant.label !== 'string' || !variant.label.trim() ||
        typeof variant.summary !== 'string' || !variant.summary.trim() || !HASH.test(variant.sha256) ||
        !Number.isSafeInteger(variant.bytes) || variant.bytes <= 0 ||
        !Number.isFinite(variant.min_ceiling_m) || variant.min_ceiling_m <= 2.35 ||
        !Number.isFinite(variant.fan_blade_height_m) || variant.fan_blade_height_m <= 2.35) invalid('invalid scheme metadata');
    if (typeof variant.src !== 'string' ||
        !new RegExp(`^\\./model/ceilings/${variant.id}-[a-f0-9]{16}\\.glb$`).test(variant.src)) invalid('unsafe asset path');
    const url = new URL(variant.src, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(new URL('./model/ceilings/', base).pathname)) invalid('unsafe asset origin');
    return { ...variant, url: url.href };
  });
  if (typeof options.note !== 'string' || !options.note.trim()) invalid('missing concept note');
  return { ...options, baseline_nodes: [...options.baseline_nodes], variants };
}

export function disposeCeiling(root) {
  if (!root) return;
  const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
  root.traverse(obj => {
    if (obj.geometry) geometries.add(obj.geometry);
    for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    if (obj.skeleton) skeletons.add(obj.skeleton);
  });
  for (const texture of textures) { texture.dispose(); texture.source?.data?.close?.(); }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}

// A hashed GLB must not pull additional, unverified external assets during parsing.
export function assertEmbeddedGLB(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength ||
      view.getUint32(16, true) !== 0x4e4f534a) throw new Error('Invalid ceiling GLB');
  const length = view.getUint32(12, true);
  if (length > bytes.byteLength - 20) throw new Error('Invalid ceiling GLB JSON');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
  if ([...(json.buffers || []), ...(json.images || [])].some(asset => asset.uri !== undefined)) {
    throw new Error('Ceiling GLB must contain embedded assets only');
  }
}

export function createCeilingComparison({ options, model, scene, parse, onChange = () => {},
  fetchAsset = fetch, digest = bytes => crypto.subtle.digest('SHA-256', bytes) }) {
  const baseline = [];
  for (const name of options.baseline_nodes) {
    const matches = [];
    model.traverse(obj => { if (obj.name === name && obj.isMesh) matches.push(obj); });
    if (matches.length !== 1) throw new Error('Ceiling comparison unavailable: baseline nodes do not match this house.');
    baseline.push({ node: matches[0], visible: matches[0].visible });
  }
  let selected = 'existing', pending = null, error = '', failed = null;
  let overlay = null, abort, generation = 0, disposed = false;
  const snapshot = () => ({
    selected, pending, overlayLoaded: Boolean(overlay),
    baselineHidden: baseline.some(({ node, visible }) => visible && !node.visible),
    baseline: baseline.map(({ node }) => ({ name: node.name, visible: node.visible })),
    error, failed, disposed,
  });
  const emit = () => onChange(snapshot());
  const removeOverlay = () => {
    if (overlay) { scene.remove(overlay); disposeCeiling(overlay); overlay = null; }
  };
  const restore = () => { for (const { node, visible } of baseline) node.visible = visible; };
  async function select(id) {
    if (disposed) return;
    const variant = options.variants.find(v => v.id === id);
    if (id !== 'existing' && !variant) return;
    const ticket = ++generation;
    abort?.abort(); abort = null;
    pending = null; error = ''; failed = null;
    if (id === 'existing') {
      removeOverlay(); restore(); selected = id; emit(); return;
    }
    if (id === selected) { emit(); return; }
    const controller = new AbortController();
    abort = controller; pending = id; emit();
    let loaded = null;
    try {
      const response = await fetchAsset(variant.url, { signal: controller.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (ticket !== generation || disposed) return;
      if (bytes.byteLength !== variant.bytes) throw new Error('asset size does not match');
      const hash = [...new Uint8Array(await digest(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (ticket !== generation || disposed) return;
      if (hash !== variant.sha256) throw new Error('SHA-256 integrity check failed');
      assertEmbeddedGLB(bytes);
      loaded = (await parse(bytes)).scene;
      if (!loaded) throw new Error('ceiling scene is missing');
      if (ticket !== generation || disposed) { disposeCeiling(loaded); return; }
      loaded.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = true; obj.receiveShadow = true;
        for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (mat?.transparent) mat.depthWrite = false;
        }
      });
      scene.add(loaded);
      removeOverlay(); overlay = loaded; loaded = null;
      for (const { node } of baseline) node.visible = false;
      selected = id; pending = null; abort = null; emit();
    } catch (cause) {
      if (loaded) { scene.remove(loaded); disposeCeiling(loaded); }
      if (ticket !== generation || disposed) return;
      pending = null; abort = null; failed = id;
      error = `Could not load ${variant.label}: ${cause.message}. Still showing ${selected === 'existing' ? 'Existing' : options.variants.find(v => v.id === selected).label}. Retry or choose Existing.`;
      emit();
    }
  }
  return {
    select, snapshot,
    retry: () => failed ? select(failed) : Promise.resolve(),
    dispose() {
      if (disposed) return;
      disposed = true; ++generation; abort?.abort(); abort = null;
      removeOverlay(); restore(); selected = 'existing'; pending = null; error = ''; failed = null; emit();
    },
  };
}
