import { GLTFLoader } from './vendor/GLTFLoader.js';

export async function loadHouseReview({ THREE, model, scene, house, signal, fetchAsset = fetch }) {
  const response = await fetchAsset('./model/review/manifest.json', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`House revision HTTP ${response.status}`);
  const data = await response.json();
  if (data?.version !== 1 || data.base_source_sha256 !== house.source_sha256 ||
      data.base_model_sha256 !== house.model_sha256 || data.model?.src !== './model/review/review-v022.glb' ||
      !/^[a-f0-9]{64}$/.test(data.model.sha256) || !Number.isSafeInteger(data.model.bytes) ||
      !Array.isArray(data.remove) || !data.remove.length || !Array.isArray(data.phone_outlets) ||
      !Array.isArray(data.furniture_nodes) || !Array.isArray(data.service_cover_nodes) ||
      new Set(data.service_cover_nodes).size !== data.service_cover_nodes.length ||
      data.service_cover_nodes.some(name => typeof name !== 'string' || !/^R22_PART_\d{4}$/.test(name) ||
        !data.furniture_nodes.includes(name)) ||
      data.phone_outlets.length !== 6 || !Array.isArray(data.rear_tv?.bounds_blender_m) ||
      data.rear_tv.bounds_blender_m.length !== 2 || data.rear_tv.bounds_blender_m.some(point =>
        !Array.isArray(point) || point.length !== 3 || point.some(value => !Number.isFinite(value)))) {
    throw new Error('House revision does not match this model.');
  }
  const objects = new Map();
  model.traverse(object => { if (object.isMesh) objects.set(object.name, object); });
  const replacements = [], seen = new Set();
  for (const entry of data.remove) {
    const object = objects.get(THREE.PropertyBinding.sanitizeNodeName(entry.node));
    if (!object?.geometry.index || object.geometry.index.count !== entry.index_count || seen.has(object) ||
        !Array.isArray(entry.ranges)) throw new Error('Window replacement geometry does not match this house.');
    seen.add(object);
    let last = 0;
    const index = object.geometry.index;
    for (const range of entry.ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) ||
          range[0] < last || range[0] % 3 || range[1] <= 0 || range[1] % 3 ||
          range[0] + range[1] > index.count) throw new Error('Invalid house revision triangle mask.');
      last = range[0] + range[1];
    }
    replacements.push({ object, original: object.geometry, ranges: entry.ranges });
  }
  let gltf;
  try {
    for (const entry of replacements) {
      entry.geometry = entry.original.clone();
      const index = entry.geometry.index;
      for (const [start, count] of entry.ranges) {
        for (let i = start; i < start + count; i += 3) {
          // Preserve source index offsets so furniture masks remain valid.
          index.setX(i + 1, index.getX(i)); index.setX(i + 2, index.getX(i));
        }
      }
      index.needsUpdate = true;
    }
    const response = await fetchAsset(data.model.src, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`House revision model HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== data.model.bytes || digest !== data.model.sha256) throw new Error('House revision model hash mismatch.');
    gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (signal.aborted) throw new Error('House revision load cancelled.');
    gltf.scene.traverse(object => {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material?.transparent) material.depthWrite = false;
      }
    });
    for (const entry of replacements) entry.object.geometry = entry.geometry;
    scene.add(gltf.scene);
  } catch (error) {
    replacements.forEach(entry => entry.geometry?.dispose());
    gltf?.scene.traverse(object => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material?.dispose());
    });
    throw error;
  }
  let disposed = false;
  const [low, high] = data.rear_tv.bounds_blender_m;
  const tvBounds = new THREE.Box3(new THREE.Vector3(low[0], low[2], -high[1]),
    new THREE.Vector3(high[0], high[2], -low[1])).expandByScalar(.12);
  const tvParts = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    const isTV = tvBounds.containsBox(new THREE.Box3().setFromObject(object));
    let furniture = false;
    for (let parent = object; parent && parent !== gltf.scene; parent = parent.parent) {
      if (data.furniture_nodes?.includes(parent.name)) { furniture = true; break; }
    }
    if (!isTV && !furniture) return;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const ghosts = source.map(material => {
      const ghost = material.clone(); ghost.transparent = true; ghost.opacity = .18; ghost.depthWrite = false;
      return ghost;
    });
    tvParts.push({ object, isTV, original: object.material, ghost: Array.isArray(object.material) ? ghosts : ghosts[0], ghosts });
  });
  let tvFurnitureMode = 'solid', serviceOpen = false;
  const isServiceCover = object => {
    for (let parent = object; parent && parent !== gltf.scene; parent = parent.parent) {
      if (data.service_cover_nodes?.includes(parent.name)) return true;
    }
    return false;
  };
  return {
    data,
    root: gltf.scene,
    snapshot: () => ({ loaded: true, phoneOutlets: 6, rearTV: true, lowerGlazedWindows: 2,
      removedTriangles: data.removed_triangles, basePreserved: true, tvFurnitureMode, tvParts: tvParts.filter(part => part.isTV).length,
      serviceOpenings: data.service_openings?.length || 0, serviceOpen }),
    setServiceOpen(value) {
      serviceOpen = Boolean(value);
      for (const part of tvParts) part.object.visible = tvFurnitureMode !== 'hidden' &&
        !(serviceOpen && isServiceCover(part.object));
    },
    setFurnitureMode(mode) {
      if (!['solid', 'transparent', 'hidden'].includes(mode)) throw new Error('Unknown furniture inspection mode.');
      if (disposed) return;
      tvFurnitureMode = mode;
      for (const part of tvParts) {
        part.object.visible = mode !== 'hidden' && !(serviceOpen && isServiceCover(part.object));
        part.object.material = mode === 'transparent' ? part.ghost : part.original;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const part of tvParts) {
        part.object.material = part.original; part.ghosts.forEach(material => material.dispose());
      }
      for (const entry of replacements) { entry.object.geometry = entry.original; entry.geometry.dispose(); }
      scene.remove(gltf.scene);
      const geometries = new Set(), materials = new Set();
      gltf.scene.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
      });
      geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose());
    },
  };
}
