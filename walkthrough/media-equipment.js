const exact = (value, keys) => value && Object.keys(value).sort().join() === keys.split(' ').sort().join();
const vector = point => Array.isArray(point) && point.length === 3 && point.every(n => Number.isFinite(n) && Math.abs(n) < 30);

export function validateMediaEquipment(data) {
  if (!exact(data, 'status receiver signals review sources') || data.status !== 'wired-5.1-proposal-not-commissioned' ||
      !exact(data.receiver, 'position_web_m size_web_m bounds_web_m') || !vector(data.receiver.position_web_m) ||
      !vector(data.receiver.size_web_m) || data.receiver.size_web_m.some(n => n <= 0) ||
      !Array.isArray(data.receiver.bounds_web_m) || data.receiver.bounds_web_m.length !== 2 ||
      !data.receiver.bounds_web_m.every(vector) || !Array.isArray(data.signals) || data.signals.length !== 12 ||
      !Array.isArray(data.review) || !data.review.every(text => typeof text === 'string' && text.length < 800) ||
      !Array.isArray(data.sources) || data.sources.some(source => !exact(source, 'title url') ||
        typeof source.title !== 'string' || !source.url.startsWith('https://manuals.denon.com/'))) {
    throw new Error('Invalid wired media proposal.');
  }
  const ids = new Set(), ports = new Set();
  for (const signal of data.signals) {
    if (!exact(signal, 'id label kind from to radius_m points_web_m') || typeof signal.id !== 'string' ||
        ids.has(signal.id) || typeof signal.label !== 'string' ||
        !['speaker-pair', 'line-level', 'hdmi', 'ethernet'].includes(signal.kind) ||
        !(signal.radius_m >= .001 && signal.radius_m <= .004) || !Array.isArray(signal.points_web_m) ||
        signal.points_web_m.length < 2 || !signal.points_web_m.every(vector)) throw new Error('Invalid media cable.');
    ids.add(signal.id);
    for (const [endpoint, point] of [[signal.from, signal.points_web_m[0]], [signal.to, signal.points_web_m.at(-1)]]) {
      if (!exact(endpoint, 'device port position_web_m bounds_web_m') || !vector(endpoint.position_web_m) ||
          !Array.isArray(endpoint.bounds_web_m) || endpoint.bounds_web_m.length !== 2 ||
          !endpoint.bounds_web_m.every(vector) || typeof endpoint.device !== 'string' || typeof endpoint.port !== 'string' ||
          point.some((n, i) => Math.abs(n - endpoint.position_web_m[i]) > .00001) ||
          point.some((n, i) => n < Math.min(...endpoint.bounds_web_m.map(p => p[i])) - .004 ||
            n > Math.max(...endpoint.bounds_web_m.map(p => p[i])) + .004)) throw new Error('Detached media cable.');
      const key = `${endpoint.device}:${endpoint.port}`;
      if (ports.has(key)) throw new Error('Media port occupied twice.');
      ports.add(key);
    }
  }
  for (const [kind, count] of [['speaker-pair', 5], ['line-level', 1], ['hdmi', 3], ['ethernet', 3]]) {
    if (data.signals.filter(signal => signal.kind === kind).length !== count) throw new Error('Incomplete media topology.');
  }
  return data;
}

export function createMediaEquipment(THREE, scene, data, roundedCordPath) {
  validateMediaEquipment(data);
  const root = new THREE.Group(), cables = new Map(), geometries = new Set(), materials = new Set();
  root.name = 'WIRED_5_1_RECEIVER_AND_PHYSICAL_SIGNAL_PROPOSALS';
  const material = (color, options = {}) => {
    const value = new THREE.MeshStandardMaterial({ color, roughness: .65, ...options }); materials.add(value); return value;
  };
  const dark = material(0x252a2b), brass = material(0x968063, { metalness: .5 });
  const screen = material(0x313c40), signalMat = material(0x444a43);
  const selectedMaterial = material(0x9a5115);
  const mesh = (geometry, mat, point, parent = root) => {
    geometries.add(geometry);
    const object = new THREE.Mesh(geometry, mat); object.position.set(...point);
    object.userData.mediaEquipmentProposal = true; parent.add(object); return object;
  };
  const box = (size, point, mat = dark, parent = root) => mesh(new THREE.BoxGeometry(...size), mat, point, parent);
  const receiver = new THREE.Group(); receiver.name = 'GENERIC_COMPACT_5_1_RECEIVER'; root.add(receiver);
  const [x, y, z] = data.receiver.position_web_m;
  box(data.receiver.size_web_m, [x, y, z], dark, receiver);
  for (const dx of [-.10, .10]) for (const dz of [-.16, .16]) {
    box([.025, .025, .025], [x + dx, y - .0875, z + dz], dark, receiver);
  }
  box([.003, .035, .16], [x - .151, y + .012, z], screen, receiver);
  for (const offset of [-.155, .155]) {
    const knob = mesh(new THREE.CylinderGeometry(.021, .021, .014, 24), brass,
      [x - .155, y, z + offset], receiver); knob.rotation.z = Math.PI / 2;
  }
  for (let i = 0; i < 12; i++) box([.16, .001, .006], [x, y + .0756, z - .16 + i * .028], screen, receiver);
  for (const signal of data.signals) {
    const cable = mesh(new THREE.TubeGeometry(roundedCordPath(THREE, signal.points_web_m),
      Math.max(48, signal.points_web_m.length * 12), signal.radius_m, 8, false), signalMat, [0, 0, 0]);
    cable.name = `MEDIA_SIGNAL_${signal.id}`; cables.set(signal.id, cable);
    for (const point of [signal.points_web_m[0], signal.points_web_m.at(-1)]) {
      mesh(new THREE.SphereGeometry(signal.radius_m * 1.8, 8, 6), brass, point);
    }
  }
  scene.add(root);
  let disposed = false, serviceOpen = false, selected = null;
  return {
    setVisible(value) { if (!disposed) root.visible = Boolean(value); },
    setServiceOpen(value) { serviceOpen = Boolean(value); },
    select(id) {
      if (id !== null && !cables.has(id)) throw new Error('Unknown media signal cable.');
      if (selected) cables.get(selected).material = signalMat;
      selected = id; if (id) cables.get(id).material = selectedMaterial;
    },
    snapshot: () => ({ receiver: true, passiveSpeakers: 5, poweredSubwoofer: true, signalCables: 12, serviceOpen, selected }),
    dispose() {
      if (disposed) return;
      disposed = true; scene.remove(root);
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); root.clear();
    },
  };
}
