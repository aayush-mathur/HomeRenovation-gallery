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
    const keep = [];
    let cursor = 0;
    for (const range of entry.hidden_ranges) {
      if (!Array.isArray(range) || range.length !== 2 ||
          !range.every(Number.isSafeInteger) || range[0] < cursor || range[0] % 3 ||
          range[1] <= 0 || range[1] % 3 || range[0] + range[1] > index.count) {
        throw new Error('Invalid furniture triangle range.');
      }
      for (; cursor < range[0]; cursor++) keep.push(index.array[cursor]);
      cursor += range[1];
    }
    for (; cursor < index.count; cursor++) keep.push(index.array[cursor]);
    const reduced = new THREE.BufferAttribute(new index.array.constructor(keep), 1);
    records.push({ object, original: index, reduced });
  }
  let visible = true;
  return {
    setVisible(value) {
      visible = Boolean(value);
      for (const record of records) record.object.geometry.setIndex(visible ? record.original : record.reduced);
    },
    snapshot: () => ({ visible, batches: records.length, hiddenTriangles: visible ? 0 : mask.hidden_triangles }),
    dispose() {
      for (const record of records) record.object.geometry.setIndex(record.original);
    },
  };
}
