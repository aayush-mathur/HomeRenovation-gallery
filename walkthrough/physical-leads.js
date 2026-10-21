const vector = point => Array.isArray(point) && point.length === 3 &&
  point.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100);
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('|') === keys.split(' ').sort().join('|');
const text = (value, limit = 600) => typeof value === 'string' && value.length > 0 && value.length < limit;

export function physicalSocketAnchor(board, control) {
  const [nx, , nz] = board.normal_web, [x, y, z] = board.position_web_m;
  const offset = ((board.size_mm[0] / 1000 - .03) / .0225 / 2 - control.slot - control.span / 2) * .0225;
  return [x - nz * offset, y - .004 + ('row' in control ? .035 - .07 * control.row : 0), z + nx * offset];
}

export function validatePhysicalLeads(value, house, descriptor, boardHash) {
  const fail = () => { throw new Error('Appliance cord data is invalid or does not match this house and its sockets.'); };
  if (!exactKeys(value, 'version id status base_source_sha256 base_model_sha256 board_manifest_sha256 leads unconnected limits aquarium media additions') ||
      value.version !== 1 || value.id !== 'physical-appliance-leads-v001' || value.status !== 'visualization-proposal-not-installation' ||
      value.base_source_sha256 !== house.source_sha256 || value.base_model_sha256 !== house.model_sha256 ||
      value.board_manifest_sha256 !== boardHash || !Array.isArray(value.leads) || !value.leads.length || value.leads.length > 100 ||
      !Array.isArray(value.limits) || !value.limits.length || !value.limits.every(item => text(item)) ||
      !Array.isArray(value.unconnected) || value.unconnected.length > 100) fail();
  const boards = new Map(descriptor.boards.map(board => [board.id, board]));
  const ids = new Set(), occupied = new Set();
  for (const lead of value.leads) {
    if (!exactKeys(lead, 'id label room board_id function_id connection_state socket_web_m normal_web adapter radius_m points_web_m length_m device_bounds_web_m terminal_basis review') ||
        !/^[a-z0-9-]{1,64}$/.test(lead.id) || ids.has(lead.id) || occupied.has(lead.function_id) || !text(lead.label, 161)) fail();
    const board = boards.get(lead.board_id), control = board?.functions.find(control => control.id === lead.function_id);
    if (!control || !['socket', 'connection-provision'].includes(control.kind) || lead.room !== board.room ||
        !vector(lead.socket_web_m) || !vector(lead.normal_web) || distance(lead.normal_web, board.normal_web) > .000001 ||
        distance(lead.socket_web_m, physicalSocketAnchor(board, control)) > .00001 ||
        typeof lead.adapter !== 'boolean' || typeof lead.radius_m !== 'number' || !(lead.radius_m >= .001 && lead.radius_m <= .006) ||
        !(control.kind === 'connection-provision' ? ['proposed-socket', 'fixed-flex-proposal'] : ['plugged-proposal']).includes(lead.connection_state) ||
        !Array.isArray(lead.points_web_m) || lead.points_web_m.length < 2 || lead.points_web_m.length > 30 || !lead.points_web_m.every(vector) ||
        !Array.isArray(lead.device_bounds_web_m) || lead.device_bounds_web_m.length !== 2 || !lead.device_bounds_web_m.every(vector) ||
        lead.terminal_basis !== 'proposed-case-surface-not-surveyed' || !Array.isArray(lead.review) || !lead.review.every(item => text(item))) fail();
    const drop = lead.connection_state === 'fixed-flex-proposal'
      ? lead.points_web_m[1][1] >= lead.socket_web_m[1] ? -.04 : .04 : lead.adapter ? .034 : .025;
    const expected = lead.socket_web_m.map((n, i) => n + lead.normal_web[i] * (lead.adapter ? .038 : .03) -
      (i === 1 ? drop : 0));
    if (distance(expected, lead.points_web_m[0]) > .00001) fail();
    const terminal = lead.points_web_m.at(-1), [a, b] = lead.device_bounds_web_m;
    if (terminal.some((n, i) => n < Math.min(a[i], b[i]) - .004 || n > Math.max(a[i], b[i]) + .004)) fail();
    const length = lead.points_web_m.slice(1).reduce((sum, point, i) => sum + distance(point, lead.points_web_m[i]), 0);
    if (!Number.isFinite(lead.length_m) || Math.abs(lead.length_m - length) > .001) fail();
    ids.add(lead.id); occupied.add(lead.function_id);
  }
  ids.clear();
  for (const issue of value.unconnected) {
    if (!exactKeys(issue, 'id room label point_web_m') || !text(issue.id, 100) || ids.has(issue.id) ||
        !text(issue.label, 300) || !descriptor.boards.some(board => board.room === issue.room) || !vector(issue.point_web_m)) fail();
    ids.add(issue.id);
  }
  validateAquariumEquipment(value.aquarium);
  validateMediaEquipment(value.media);
  if (!exactKeys(value.additions, 'model_sha256 phone_outlets') || !/^[a-f0-9]{64}$/.test(value.additions.model_sha256) ||
      !Array.isArray(value.additions.phone_outlets) || value.additions.phone_outlets.length !== 6 ||
      value.additions.phone_outlets.some(outlet => !exactKeys(outlet, 'id room label position_web_m normal_web status') ||
        !vector(outlet.position_web_m) || !vector(outlet.normal_web) ||
        outlet.status !== 'proposed-empty-outlet-circuit-and-product-unselected')) fail();
  return value;
}

// Rounded polyline stays within each corner's convex hull; a global spline can bow through joinery.
export function roundedCordPath(THREE, coordinates) {
  const points = coordinates.map(point => new THREE.Vector3(...point)), path = new THREE.CurvePath();
  let previous = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i], next = points[i + 1];
    const radius = Math.min(.012, previous.distanceTo(corner) * .3, corner.distanceTo(next) * .3);
    const enter = corner.clone().lerp(previous, radius / Math.max(.000001, previous.distanceTo(corner)));
    const leave = corner.clone().lerp(next, radius / Math.max(.000001, corner.distanceTo(next)));
    if (previous.distanceTo(enter) > .000001) path.add(new THREE.LineCurve3(previous, enter));
    path.add(new THREE.QuadraticBezierCurve3(enter, corner, leave));
    previous = leave;
  }
  path.add(new THREE.LineCurve3(previous, points.at(-1)));
  return path;
}

export function createPhysicalLeadOverlay(THREE, scene, data) {
  const root = new THREE.Group(), assemblies = new Map(), materials = new Set(), geometries = new Set();
  root.name = 'PHYSICAL_APPLIANCE_CORDS_AND_PLUG_PROPOSALS';
  const rubber = new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: .84 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0xe3dfd4, roughness: .55 });
  const brass = new THREE.MeshStandardMaterial({ color: 0x95713b, roughness: .4, metalness: .6 });
  const proposal = new THREE.MeshStandardMaterial({ color: 0xb8792a, roughness: .7 });
  const selectedMaterial = new THREE.MeshStandardMaterial({ color: 0x9a5115, roughness: .7 });
  for (const material of [rubber, plastic, brass, proposal, selectedMaterial]) materials.add(material);
  let disposed = false, selected = null;
  function mesh(geometry, material, parent, position = [0, 0, 0]) {
    geometries.add(geometry);
    const object = new THREE.Mesh(geometry, material);
    object.position.set(...position); object.userData.physicalApplianceLead = true;
    object.castShadow = false; object.receiveShadow = false;
    parent.add(object); return object;
  }
  for (const lead of data.leads) {
    const group = new THREE.Group(), plug = new THREE.Group();
    group.name = lead.id; group.userData.physicalApplianceLead = true;
    plug.position.set(...lead.socket_web_m);
    plug.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...lead.normal_web));
    group.add(plug);
    const fixed = lead.connection_state === 'fixed-flex-proposal';
    const depth = fixed ? .03 : lead.adapter ? .044 : .036, height = fixed ? .06 : lead.adapter ? .062 : .044;
    const body = mesh(new THREE.BoxGeometry(lead.adapter ? .04 : .035, height, depth),
      lead.adapter ? rubber : plastic, plug, [0, 0, depth / 2]);
    for (const [x, y] of fixed ? [] : [[0, .012], [-.009, -.006], [.009, -.006]]) {
      const pin = mesh(new THREE.CylinderGeometry(.0023, .0023, .010, 8), brass, plug, [x, y, -.004]);
      pin.rotation.x = Math.PI / 2;
    }
    const exitHeight = fixed ? Math.sign(lead.points_web_m[0][1] - lead.socket_web_m[1]) * .035
      : lead.adapter ? -.034 : -.025;
    mesh(new THREE.CylinderGeometry(lead.radius_m * 1.7, lead.radius_m * 1.3, .014, 10), rubber, plug,
      [0, exitHeight, lead.adapter ? .038 : .03]);
    if (lead.connection_state === 'proposed-socket') {
      mesh(new THREE.BoxGeometry(.058, .074, .002), plastic, plug, [0, .004, -.001]);
      const border = mesh(new THREE.TorusGeometry(.023, .0011, 6, 32), proposal, plug, [0, 0, .001]);
      border.scale.y = 1.25;
    }
    const curve = roundedCordPath(THREE, lead.points_web_m);
    const cord = mesh(new THREE.TubeGeometry(curve, Math.max(32, lead.points_web_m.length * 12), lead.radius_m, 8, false), rubber, group);
    mesh(new THREE.SphereGeometry(lead.radius_m * 1.4, 10, 8), rubber, group, lead.points_web_m.at(-1));
    for (let i = 1; i < lead.points_web_m.length - 1; i++) {
      const a = new THREE.Vector3(...lead.points_web_m[i - 1]), b = new THREE.Vector3(...lead.points_web_m[i]);
      const direction = b.clone().sub(a), count = Math.floor(direction.length() / .22);
      for (let j = 1; j <= count; j++) {
        const point = a.clone().lerp(b, j / (count + 1));
        const normal = new THREE.Vector3(...lead.normal_web), anchor = new THREE.Vector3(...lead.socket_web_m);
        const gap = point.clone().sub(anchor).dot(normal) + .012;
        if (gap < .006 || gap > .075) continue;
        const clip = mesh(new THREE.TorusGeometry(lead.radius_m + .0015, .0015, 6, 12), plastic, group, point.toArray());
        clip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
        const foot = point.clone().addScaledVector(normal, -gap);
        const plate = mesh(new THREE.BoxGeometry(.018, .024, .003), plastic, group, foot.toArray());
        plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        const stem = mesh(new THREE.CylinderGeometry(.002, .002, gap, 6), plastic, group,
          point.clone().addScaledVector(normal, -gap / 2).toArray());
        stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      }
    }
    if (fixed) mesh(new THREE.SphereGeometry(.006, 10, 8), plastic, group, lead.points_web_m.at(-1));
    root.add(group); assemblies.set(lead.id, { group, body, cord, length: curve.getLength() });
  }
  scene.add(root);
  const aquarium = createAquariumEquipment(THREE, scene, data.aquarium, roundedCordPath);
  const media = createMediaEquipment(THREE, scene, data.media, roundedCordPath);
  return {
    setVisible(value) { if (!disposed) { root.visible = Boolean(value); aquarium.setVisible(value); media.setVisible(value); } },
    setServiceOpen(value) { if (!disposed) { aquarium.setServiceOpen(value); media.setServiceOpen(value); } },
    selectSignal(id) { if (!disposed) media.select(id); },
    select(id) {
      if (disposed) return;
      if (id !== null && !assemblies.has(id)) throw new Error('Unknown appliance cord.');
      if (selected) {
        const previous = assemblies.get(selected), lead = data.leads.find(item => item.id === selected);
        previous.cord.material = rubber; previous.body.material = lead.adapter ? rubber : plastic;
      }
      selected = id;
      if (id) { const entry = assemblies.get(id); entry.body.material = entry.cord.material = selectedMaterial; }
    },
    snapshot: () => ({
      enabled: root.visible, selected, count: assemblies.size, kind: 'solid-3d-flex-and-plugs',
      proposedSockets: data.leads.filter(lead => lead.connection_state === 'proposed-socket').length,
      unconnected: data.unconnected.length,
      aquarium: aquarium.snapshot(),
      media: media.snapshot(),
      renderedLengths: Object.fromEntries([...assemblies].map(([id, value]) => [id, Number(value.length.toFixed(3))])),
    }),
    dispose() {
      if (disposed) return;
      disposed = true; scene.remove(root); aquarium.dispose(); media.dispose();
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      root.clear(); assemblies.clear();
    },
  };
}

export function initPhysicalLeads({ THREE, scene, container, house, descriptor, boardHash, fetchAsset = fetch,
  reviewDescriptor = null, inspectSocket = () => {}, aimAt = () => {}, releaseInput = () => {}, setJoineryServiceOpen = () => {} }) {
  if (!container) throw new Error('Appliance cords require their controls mount.');
  const document = container.ownerDocument, lifetime = new AbortController();
  let data = null, overlay = null, disposed = false, loading = false, error = '', request;
  const el = (tag, content) => { const node = document.createElement(tag); if (content) node.textContent = content; return node; };
  const panel = el('section'), title = el('h3', 'Appliance cords'), show = el('input');
  show.type = 'checkbox'; show.checked = true; show.disabled = true;
  const toggle = el('label'); toggle.append(show, document.createTextNode('Show actual 3D cords & plugs'));
  const service = el('input'); service.type = 'checkbox'; service.disabled = true;
  service.setAttribute('aria-label', 'Open aquarium and speaker cable service covers');
  const serviceLabel = el('label'); serviceLabel.append(service,
    document.createTextNode('Open aquarium / speaker cable service covers'));
  const select = el('select'); select.setAttribute('aria-label', 'Appliance cord or missing supply'); select.disabled = true;
  const label = el('label', 'Inspect a connection'); label.append(select);
  const focus = el('button', 'View socket close-up'), load = el('button', 'Look at device');
  focus.type = load.type = 'button'; focus.disabled = load.disabled = true;
  const actions = el('div'); actions.className = 'physical-lead-actions'; actions.append(focus, load);
  const status = el('p', 'Loading physical appliance cords…'); status.setAttribute('role', 'status');
  const detail = el('div'); detail.setAttribute('aria-live', 'polite');
  const retry = el('button', 'Retry appliance cords'); retry.type = 'button'; retry.hidden = true;
  const notes = el('details'); notes.append(el('summary', 'What these cords do not prove'));
  const review = el('details'); review.append(el('summary', 'Wire review · fixes still needed'));
  panel.className = 'physical-leads'; panel.append(title, toggle, serviceLabel,
    el('p', 'Solid flex goes into individual sockets. Amber means the selected cord. Use transparent furniture to see concealed sections.'),
    label, actions, detail, status, retry, review, notes); container.replaceChildren(panel);
  const on = (target, event, callback) => target.addEventListener(event, callback, { signal: lifetime.signal });
  function selection() { return data?.leads.find(lead => lead.id === select.value); }
  function selectedSignal() { return data?.media.signals.find(signal => `signal:${signal.id}` === select.value); }
  function render() {
    const lead = selection(), signal = selectedSignal(), issue = data?.unconnected.find(issue => `missing:${issue.id}` === select.value);
    show.disabled = service.disabled = select.disabled = !data; focus.disabled = !lead && !signal && !issue?.id.startsWith('aquarium'); load.disabled = !lead && !signal && !issue;
    focus.textContent = signal ? 'View signal endpoint' : 'View socket close-up';
    retry.hidden = !error; retry.disabled = loading; detail.replaceChildren();
    if (lead) {
      detail.append(el('p', `${lead.label} → ${lead.board_id} · ${lead.function_id} · ~${lead.length_m.toFixed(2)} m drawn flex`));
      if (lead.connection_state === 'proposed-socket') detail.append(el('strong', 'PROPOSED SOCKET on a blank reservation — termination and rating not selected.'));
      if (lead.connection_state === 'fixed-flex-proposal') detail.append(el('strong', 'FIXED SHEATHED LEAD proposal · not a plug · not energized or installation-approved.'));
      for (const note of lead.review) detail.append(el('p', note));
    } else if (signal) {
      detail.append(el('p', `${signal.label} · ${signal.kind} · ${signal.from.port} → ${signal.to.port}`),
        el('p', 'Actual 3D signal cable, not a mains feed. Open service covers to inspect the concealed perimeter run. Product, polarity, cable class and calibration remain provisional.'));
    } else if (issue) {
      detail.append(el('strong', `${issue.label}. Not shown as powered; no invented extension board or supply.`));
      if (issue.id.startsWith('aquarium')) for (const note of data.aquarium.review) detail.append(el('p', note));
    }
    overlay?.select(lead?.id || null); overlay?.setVisible(show.checked);
    overlay?.setServiceOpen(service.checked);
    setJoineryServiceOpen(service.checked);
    overlay?.selectSignal(signal?.id || null);
    status.dataset.error = String(Boolean(error));
    status.textContent = error || (data ? `${data.leads.length} appliance leads + 3 aquarium cords + ${data.media.signals.length} media signal cables · NOT energized; fixed-feed design/protection remain unapproved · ${data.unconnected.length} missing or deferred connections. ${show.checked ? 'Cords are ON.' : 'Cords are hidden.'}` : 'Loading physical appliance cords…');
  }
  async function initialize() {
    if (loading || disposed) return;
    loading = true; error = ''; render();
    request = new AbortController();
    const timer = setTimeout(() => request.abort(new Error('Appliance cord loading timed out')), 15000);
    try {
      const response = await fetchAsset(new URL('./model/electrical/physical-leads.json', document.baseURI),
        { signal: request.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`Appliance cords HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const planHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const value = validatePhysicalLeads(JSON.parse(new TextDecoder().decode(bytes)), house, descriptor, boardHash);
      if (reviewDescriptor?.model.sha256 !== value.additions.model_sha256) throw new Error('TV / phone-outlet review overlay is unavailable or stale.');
      if (disposed) return;
      if (request.signal.aborted) throw request.signal.reason;
      overlay = createPhysicalLeadOverlay(THREE, scene, value); data = value;
      select.replaceChildren(new Option('All cords · no highlight', ''),
        ...data.leads.map(lead => new Option(lead.label, lead.id)),
        ...data.media.signals.map(signal => new Option(signal.label, `signal:${signal.id}`)),
        ...data.unconnected.map(issue => new Option(`NOT POWERED / PENDING · ${issue.label}`, `missing:${issue.id}`)));
      notes.append(...data.limits.map(note => el('p', note)));
      const mediaNotes = el('details'); mediaNotes.append(el('summary', 'Wired 5.1 · receiver, speakers and network'));
      mediaNotes.append(...data.media.review.map(note => el('p', note)));
      const aquariumNotes = el('details'); aquariumNotes.append(el('summary', 'Aquarium · removable cable management'));
      aquariumNotes.append(...data.aquarium.review.map(note => el('p', note)));
      panel.append(aquariumNotes, mediaNotes);
      const spare = el('details'); spare.append(el('summary', '6 phone outlets · integrated bedside plates · empty'));
      for (const outlet of data.additions.phone_outlets) {
        const button = el('button', `${outlet.id.replace('EB-', '')} · view spare phone socket`); button.type = 'button';
        on(button, 'click', () => {
          try { inspectSocket(outlet.position_web_m, outlet.normal_web, outlet.room, 'Separate phone outlet · empty; electrical design provisional'); }
          catch (cause) { error = cause.message; render(); }
        });
        spare.append(button);
      }
      panel.append(spare);
      try {
        const response = await fetchAsset(new URL('./model/review/cord-review.json', document.baseURI),
          { signal: request.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const report = await response.json();
        const expected = [...data.leads.map(lead => lead.id), ...data.aquarium.cords.map(cord => `aquarium-${cord.id}`),
          ...data.media.signals.map(signal => `media-${signal.id}`)];
        if (report.version !== 1 || report.physical_leads_sha256 !== planHash || report.base_source_sha256 !== house.source_sha256 ||
            report.base_model_sha256 !== house.model_sha256 || report.review_model_sha256 !== data.additions.model_sha256 ||
            !Array.isArray(report.results) || report.results.length !== expected.length ||
            new Set(report.results.map(item => item.id)).size !== expected.length ||
            report.results.some(item => !expected.includes(item.id) || typeof item.action !== 'string') ||
            !Array.isArray(report.sources) || report.sources.some(source => !/^https:\/\//.test(source.url))) {
          throw new Error('Review does not match the current cords and model');
        }
        review.append(el('p', report.verdict), el('p', report.method));
        for (const item of report.results) {
          review.append(el('p', `${item.label}: ${item.action}`));
        }
        for (const source of report.sources) {
          const link = el('a', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          const line = el('p'); line.append(link, document.createTextNode(` — ${source.use}`)); review.append(line);
        }
      } catch (cause) {
        if (!disposed) review.append(el('p', `Wire review unavailable: ${cause.message}. Cords remain illustrative, not installation-ready. Reload to retry.`));
      }
    } catch (cause) {
      if (!disposed) error = `${cause.message} Appliance cords are not shown. Walking and switchboards remain available.`;
    } finally { clearTimeout(timer); loading = false; if (!disposed) render(); }
  }
  on(panel, 'pointerdown', releaseInput); on(panel, 'focusin', releaseInput);
  on(show, 'change', render); on(service, 'change', render); on(select, 'change', render); on(retry, 'click', initialize);
  on(focus, 'click', () => {
    const lead = selection();
    const signal = selectedSignal();
    if (signal) {
      try {
        const point = signal.to.position_web_m;
        inspectSocket(point, [point[0] < 1 ? 1 : -1, 0, 0], 'lounge', signal.label, 'equipment');
      } catch (cause) { error = cause.message; render(); }
      return;
    }
    const issue = data?.unconnected.find(issue => `missing:${issue.id}` === select.value);
    if (!lead && !issue?.id.startsWith('aquarium')) return;
    try { inspectSocket(lead?.socket_web_m || issue.point_web_m,
      lead?.normal_web || (issue.id === 'aquarium' ? [0, 0, -1] : [1, 0, 0]), lead?.room || 'lounge',
      lead?.label || (issue.id === 'aquarium-panel' ? 'Aquarium panel · fixed feed PROPOSED, NOT energized' : 'Aquarium equipment · battery feeder; panel NOT energized'),
      issue?.id === 'aquarium' ? 'equipment' : issue?.id === 'aquarium-panel' ? 'panel' : 'socket'); }
    catch (cause) { error = cause.message; render(); }
  });
  on(load, 'click', () => {
    const lead = selection(), signal = selectedSignal(), issue = data?.unconnected.find(issue => `missing:${issue.id}` === select.value);
    if (lead || issue || signal) aimAt(lead?.points_web_m.at(-1) || signal?.to.position_web_m || issue.point_web_m);
  });
  const ready = initialize();
  return {
    ready,
    select(id) {
      if (!data?.leads.some(lead => lead.id === id)) throw new Error('Unknown appliance cord.');
      select.value = id; render();
    },
    inspect(id) {
      if (id === 'aquarium' || id === 'aquarium-panel') {
        const issue = data?.unconnected.find(item => item.id === id);
        if (!issue) throw new Error('Aquarium equipment not loaded.');
        select.value = `missing:${id}`; render();
        inspectSocket(issue.point_web_m, id === 'aquarium' ? [0, 0, -1] : [1, 0, 0], 'lounge', id === 'aquarium-panel'
          ? 'Aquarium proposed panel · fixed feed PROPOSED, NOT energized' : 'Aquarium equipment · battery feeder; panel NOT energized',
        id === 'aquarium' ? 'equipment' : 'panel');
        return;
      }
      const lead = data?.leads.find(lead => lead.id === id);
      if (!lead) throw new Error('Unknown appliance cord.');
      select.value = id; render(); inspectSocket(lead.socket_web_m, lead.normal_web, lead.room, lead.label);
    },
    snapshot: () => ({ loaded: Boolean(data), loading, error, disposed, ...overlay?.snapshot() }),
    dispose() {
      if (disposed) return;
      disposed = true; lifetime.abort(); request?.abort(); overlay?.dispose(); container.replaceChildren();
    },
  };
}
import { createAquariumEquipment, validateAquariumEquipment } from './aquarium-equipment.js';
import { createMediaEquipment, validateMediaEquipment } from './media-equipment.js';
