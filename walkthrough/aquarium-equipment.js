export function validateAquariumEquipment(value) {
  const vector = point => Array.isArray(point) && point.length === 3 && point.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 30);
  if (!value || Object.keys(value).sort().join() !== 'bodies,cords,panel,review,service,status' ||
      value.status !== 'proposed-equipment-unenergized-panel' ||
      !Array.isArray(value.bodies) || value.bodies.length !== 4 ||
      value.bodies.map(body => body.id).join() !== 'filter,heater,feeder,light' ||
      !Array.isArray(value.cords) || value.cords.length !== 3 ||
      value.cords.map(cord => cord.id).join() !== 'filter,heater,light' ||
      !Array.isArray(value.review) || !value.review.length || !value.review.every(text => typeof text === 'string' && text.length < 700) ||
      !Array.isArray(value.service) || value.service.length !== 26 || value.service.some(part =>
        Object.keys(part).sort().join() !== 'cover,id,position_web_m,size_web_m' || typeof part.id !== 'string' ||
        typeof part.cover !== 'boolean' || !vector(part.position_web_m) || !vector(part.size_web_m) ||
        part.size_web_m.some(n => n <= 0 || n > 2)) ||
      !value.panel || Object.keys(value.panel).sort().join() !== 'feed_points_web_m,feed_state,position_web_m,sockets_web_m' ||
      value.panel.feed_state !== 'FIXED-FEED-PROPOSAL-NOT-ENERGIZED' || !vector(value.panel.position_web_m) ||
      !Array.isArray(value.panel.feed_points_web_m) || value.panel.feed_points_web_m.length !== 5 ||
      !value.panel.feed_points_web_m.every(vector) ||
      !Array.isArray(value.panel.sockets_web_m) || value.panel.sockets_web_m.length !== 4 || !value.panel.sockets_web_m.every(vector)) {
    throw new Error('Aquarium equipment proposal is invalid.');
  }
  for (const body of value.bodies) {
    if (Object.keys(body).sort().join() !== 'id,label,position_web_m,power,size_web_m' ||
        !vector(body.position_web_m) || !vector(body.size_web_m) || body.size_web_m.some(n => n <= 0 || n > 2) ||
        typeof body.label !== 'string' || body.label.length > 150 ||
        body.power !== (body.id === 'feeder' ? 'battery-no-mains-cord' : 'proposed-panel-outlet')) {
      throw new Error('Invalid aquarium equipment body.');
    }
  }
  for (const [index, cord] of value.cords.entries()) {
    const body = value.bodies.find(body => body.id === cord.id);
    if (Object.keys(cord).sort().join() !== 'id,points_web_m,socket_index' || cord.socket_index !== index ||
        !Array.isArray(cord.points_web_m) || cord.points_web_m.length < 4 || cord.points_web_m.length > 25 ||
        !cord.points_web_m.every(vector)) throw new Error('Invalid aquarium equipment cord.');
    const expected = value.panel.sockets_web_m[index].map((n, axis) => n + (axis === 0 ? .03 : axis === 1 ? -.025 : 0));
    if (Math.hypot(...expected.map((n, axis) => n - cord.points_web_m[0][axis])) > .00001 ||
        cord.points_web_m.at(-1).some((n, axis) => Math.abs(n - body.position_web_m[axis]) > body.size_web_m[axis] / 2 + .004)) {
      throw new Error('Aquarium cord misses its plug or device.');
    }
    if (Math.min(...cord.points_web_m.slice(1, 4).map(point => point[1])) >= value.panel.sockets_web_m[index][1] - .1) {
      throw new Error('Aquarium cord has no illustrated drip loop.');
    }
  }
  return value;
}

export function createAquariumEquipment(THREE, scene, data, roundedCordPath) {
  validateAquariumEquipment(data);
  const root = new THREE.Group(), geometry = new Set(), materials = new Set(), covers = [];
  root.name = 'AQUARIUM_PROVISIONAL_EQUIPMENT_UNENERGIZED_PANEL';
  const material = (color, options = {}) => {
    const value = new THREE.MeshStandardMaterial({ color, roughness: .6, ...options });
    materials.add(value); return value;
  };
  const dark = material(0x242b2c), metal = material(0x758789, { metalness: .5 }), amber = material(0xc27a24);
  const pale = material(0xdfdfd2), lamp = material(0xe5ede0), oak = material(0x896b4d, { roughness: .82 });
  function mesh(shape, mat, position) {
    geometry.add(shape);
    const object = new THREE.Mesh(shape, mat); object.position.set(...position);
    object.userData.aquariumEquipmentProposal = true; root.add(object); return object;
  }
  const box = (size, position, mat = dark) => mesh(new THREE.BoxGeometry(...size), mat, position);
  const cord = (points, radius = .0028, mat = dark) => mesh(new THREE.TubeGeometry(roundedCordPath(THREE, points),
    Math.max(48, points.length * 12), radius, 8, false), mat, [0, 0, 0]);
  for (const part of data.service) {
    const object = box(part.size_web_m, part.position_web_m, part.id.startsWith('rear-trough') ? dark : oak);
    object.name = `AQUARIUM_SERVICE_${part.id}`;
    if (part.cover) covers.push(object);
  }
  for (const body of data.bodies) {
    const [x, y, z] = body.position_web_m;
    if (body.id === 'heater') {
      mesh(new THREE.CylinderGeometry(.015, .015, .31, 16), metal, body.position_web_m);
      mesh(new THREE.CylinderGeometry(.019, .019, .035, 12), dark, [x, y + .14, z]);
      for (const height of [y - .09, y + .07]) {
        box([.05, .022, .018], [x, height, z + .024]);
      }
    } else {
      if (body.id !== 'filter') box(body.size_web_m, body.position_web_m, body.id === 'light' ? metal : dark);
      if (body.id === 'filter') {
        for (let i = 0; i < 7; i++) box([.058, .004, .003], [x, y - .10 + i * .025, z - .023], metal);
        box([.026, .018, .025], [x, y + .12, z - .025], metal);
      }
      if (body.id === 'feeder') {
        const drum = mesh(new THREE.CylinderGeometry(.045, .045, .065, 20), amber, [x, y + .008, z - .053]);
        drum.rotation.x = Math.PI / 2;
        box([.034, .035, .05], [x, y - .05, z - .045], pale);
        box([.07, .038, .018], [x, y - .055, -5.253]);
        box([.033, .016, .022], [x, y + .045, z], pale);
      }
      if (body.id === 'light') {
        box([1.18, .004, .025], [x, y - .014, z], lamp);
        for (const end of [1.0, 2.30]) box([.024, .044, .19], [end, 1.309, -5.40], metal);
      }
    }
  }
  const [px, py, pz] = data.panel.position_web_m;
  box([.024, .32, .25], [px, py, pz], pale);
  for (const [index, socket] of data.panel.sockets_web_m.entries()) {
    const [x, y, z] = socket;
    box([.004, .078, .078], socket, pale);
    for (const [dy, dz] of [[.014, 0], [-.009, -.01], [-.009, .01]]) {
      const hole = mesh(new THREE.CylinderGeometry(.003, .003, .006, 8), dark, [x + .003, y + dy, z + dz]);
      hole.rotation.z = Math.PI / 2;
    }
    if (index < 3) {
      box([.036, .044, .035], [x + .018, y, z], dark);
      mesh(new THREE.CylinderGeometry(.0045, .0035, .014, 10), dark, [x + .03, y - .025, z]);
    }
  }
  for (const lead of data.cords) cord(lead.points_web_m);
  for (const [x, z] of [[1.0325, -5.294], [2.15, -5.29], [1.80, -5.325]]) {
    const opening = mesh(new THREE.TorusGeometry(.022, .002, 8, 32), dark, [x, 1.288, z]);
    opening.rotation.x = Math.PI / 2;
  }
  cord(data.panel.feed_points_web_m, .009, pale);
  // This is proposed protective containment, not proof of an energized circuit.
  box([.027, .026, .025], [px, .23, pz], amber);
  scene.add(root);
  let disposed = false, serviceOpen = false;
  return {
    setVisible(value) { if (!disposed) root.visible = Boolean(value); },
    setServiceOpen(value) { serviceOpen = Boolean(value); for (const cover of covers) cover.visible = !serviceOpen; },
    snapshot: () => ({ bodies: 4, cords: 3, feeder: 'battery-no-mains-cord', panelFeed: data.panel.feed_state,
      serviceOpen, removableCovers: covers.length }),
    dispose() {
      if (disposed) return;
      disposed = true; scene.remove(root); geometry.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); root.clear();
    },
  };
}
