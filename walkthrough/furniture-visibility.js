export function createFurnitureVisibility(THREE, root, mask, modelHash) {
  if (mask?.version !== 1 || mask.model_sha256 !== modelHash || !Array.isArray(mask.meshes) || !mask.meshes.length) {
    throw new Error('Furniture visibility data does not match this house.');
  }
  const meshes = new Map();
  root.traverse(object => {
    if (object.isMesh) meshes.set(object.name, object);
  });
  const records = [], seen = new Set();
  for (const entry of mask.meshes) {
    const object = meshes.get(THREE.PropertyBinding.sanitizeNodeName(entry.node));
    const index = object?.geometry.index;
    if (!index || seen.has(object) || index.count !== entry.index_count || !Array.isArray(entry.hidden_ranges)) {
      throw new Error('Furniture geometry is stale or ambiguous.');
    }
    seen.add(object);
    const keep = [], furniture = [], keptOffsets = [], furnitureOffsets = [];
    let cursor = 0;
    for (const range of entry.hidden_ranges) {
      if (!Array.isArray(range) || range.length !== 2 ||
          !range.every(Number.isSafeInteger) || range[0] < cursor || range[0] % 3 ||
          range[1] <= 0 || range[1] % 3 || range[0] + range[1] > index.count) {
        throw new Error('Invalid furniture triangle range.');
      }
      for (; cursor < range[0]; cursor++) { keep.push(index.array[cursor]); keptOffsets.push(cursor); }
      for (let i = cursor; i < cursor + range[1]; i++) { furniture.push(index.array[i]); furnitureOffsets.push(i); }
      cursor += range[1];
    }
    for (; cursor < index.count; cursor++) { keep.push(index.array[cursor]); keptOffsets.push(cursor); }
    records.push({ object, original: object.geometry, keep, furniture, keptOffsets, furnitureOffsets });
  }
  function partition(original, indices, offsets) {
    const geometry = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(original.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(new THREE.BufferAttribute(new original.index.array.constructor(indices), 1));
    for (const group of original.groups) {
      const start = offsets.findIndex(offset => offset >= group.start && offset < group.start + group.count);
      if (start < 0) continue;
      let end = start;
      while (end < offsets.length && offsets[end] < group.start + group.count) end++;
      geometry.addGroup(start, end - start, group.materialIndex);
    }
    geometry.boundingBox = original.boundingBox?.clone() || null;
    geometry.boundingSphere = original.boundingSphere?.clone() || null;
    return geometry;
  }
  for (const record of records) {
    record.reduced = partition(record.original, record.keep, record.keptOffsets);
    const geometry = partition(record.original, record.furniture, record.furnitureOffsets);
    const source = Array.isArray(record.object.material) ? record.object.material : [record.object.material];
    record.materials = source.map(material => {
      const ghost = material.clone();
      ghost.transparent = true; ghost.opacity = .18; ghost.depthWrite = false;
      return ghost;
    });
    record.ghost = new THREE.Mesh(geometry, Array.isArray(record.object.material) ? record.materials : record.materials[0]);
    record.ghost.name = `${record.object.name}_inspection_furniture`;
    record.ghost.visible = false;
    record.ghost.userData.inspectionFurniture = true;
    record.ghost.renderOrder = 2;
    record.object.add(record.ghost);
    delete record.keep; delete record.furniture; delete record.keptOffsets; delete record.furnitureOffsets;
  }
  let mode = 'solid', disposed = false;
  function setMode(value) {
    if (!['solid', 'transparent', 'hidden'].includes(value)) throw new Error('Unknown furniture inspection mode.');
    if (disposed) return;
    mode = value;
    for (const record of records) {
      record.object.geometry = mode === 'solid' ? record.original : record.reduced;
      record.ghost.visible = mode === 'transparent';
    }
  }
  return {
    setMode,
    setVisible(value) { setMode(value ? 'solid' : 'hidden'); },
    snapshot: () => ({ mode, visible: mode !== 'hidden', batches: records.length,
      hiddenTriangles: mode === 'hidden' ? mask.hidden_triangles : 0,
      transparentTriangles: mode === 'transparent' ? mask.hidden_triangles : 0 }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records) {
        record.object.geometry = record.original;
        record.object.remove(record.ghost);
        record.reduced.dispose(); record.ghost.geometry.dispose();
        for (const material of record.materials) material.dispose();
      }
    },
  };
}
