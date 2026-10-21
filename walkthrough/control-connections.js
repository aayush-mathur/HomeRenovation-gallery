const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const vector = value => Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(n) && Math.abs(n) < 100);

export function validateControlPlan(value, house, descriptor, boardHash) {
  const fail = () => { throw new Error('Control plan is invalid or does not match this house and its boards.'); };
  if (value?.version !== 1 || value.decision !== 'conventional-wired-smart-ready' ||
      value.status !== 'functional-review-not-for-installation' ||
      value.base_source_sha256 !== house.source_sha256 || value.base_model_sha256 !== house.model_sha256 ||
      value.board_manifest_sha256 !== boardHash ||
      !Array.isArray(value.groups) || value.groups.length !== descriptor.fixture_groups.length ||
      !Array.isArray(value.controls) ||
      !Array.isArray(value.requirements) || !Array.isArray(value.drawing_limits) ||
      ![...value.requirements, ...value.drawing_limits].every(text => typeof text === 'string' && text.length < 1000)) fail();
  const groups = new Map(descriptor.fixture_groups.map(group => [group.id, group]));
  const seen = new Set();
  for (const group of value.groups) {
    if (!groups.has(group.id) || seen.has(group.id) || group.room !== groups.get(group.id).room ||
        typeof group.label !== 'string' || !group.label || group.label.length > 160 ||
        !['light', 'fan', 'equipment'].includes(group.kind) ||
        !['functional-zone-only', 'modeled-object-center', 'provisional-accessory', 'unresolved'].includes(group.endpoint_basis) ||
        !Array.isArray(group.points_web_m) || group.points_web_m.length > 30 || !group.points_web_m.every(vector) ||
        (group.endpoint_basis === 'unresolved' && group.points_web_m.length !== 0) ||
        (group.endpoint_basis !== 'unresolved' && group.points_web_m.length === 0) ||
        (group.kind === 'light' && group.fitting_count !== null)) fail();
    seen.add(group.id);
  }
  const controls = new Map(descriptor.boards.flatMap(board => board.functions.map(control => [control.id, { board, control }])));
  if (value.controls.length !== controls.size) fail();
  seen.clear();
  for (const control of value.controls) {
    const original = controls.get(control.id);
    if (!original || seen.has(control.id) || control.board_id !== original.board.id || control.room !== original.board.room ||
        control.kind !== original.control.kind || control.backup_preference !== original.control.backup_preference ||
        typeof control.lighting_control !== 'boolean' || typeof control.label !== 'string' || !control.label ||
        control.label.length > 400 || JSON.stringify(control.group_ids) !== JSON.stringify(original.control.fixture_group_ids)) fail();
    seen.add(control.id);
  }
  return value;
}

export function createConnectionOverlay(THREE, scene, plan, boards) {
  const root = new THREE.Group();
  root.name = 'CONTROL_RELATIONSHIPS_NOT_CABLE_ROUTES';
  root.visible = false;
  scene.add(root);
  const groups = new Map(plan.groups.map(group => [group.id, group]));
  let selected = null, segments = 0, disposed = false;
  function clear() {
    for (const child of [...root.children]) {
      root.remove(child); child.geometry.dispose(); child.material.dispose();
    }
    segments = 0;
  }
  return {
    select(id, enabled = true) {
      if (disposed) return;
      const control = plan.controls.find(control => control.id === id);
      if (!control) throw new Error('Unknown control relationship.');
      clear(); selected = id; root.visible = enabled;
      const sources = control.lighting_control ? plan.controls.filter(other =>
        other.lighting_control && other.group_ids.some(id => control.group_ids.includes(id))) : [control];
      for (const groupID of control.group_ids) {
        const group = groups.get(groupID);
        for (const source of sources.filter(source => source.group_ids.includes(groupID))) {
          const board = boards.find(board => board.id === source.board_id);
          const start = new THREE.Vector3(...board.position_web_m).addScaledVector(new THREE.Vector3(...board.normal_web), .035);
          for (const point of group.points_web_m) {
            const end = new THREE.Vector3(...point);
            const color = group.kind === 'light' ? 0xa86700 : group.kind === 'fan' ? 0x126c70 : 0x225fbe;
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]),
              new THREE.LineDashedMaterial({ color, dashSize: .09, gapSize: .055, depthTest: true }));
            line.computeLineDistances(); root.add(line);
            const marker = new THREE.Mesh(new THREE.SphereGeometry(.055, 12, 8),
              new THREE.MeshBasicMaterial({ color, wireframe: group.endpoint_basis === 'functional-zone-only' }));
            marker.position.copy(end); root.add(marker);
            segments++;
          }
        }
      }
    },
    setEnabled(value) { if (!disposed) root.visible = Boolean(value); },
    snapshot: () => ({ enabled: root.visible, selected, segments, kind: 'relationships-not-routes' }),
    dispose() { if (!disposed) { clear(); scene.remove(root); disposed = true; } },
  };
}

export function initControlConnections({ THREE, scene, stage, container, house, descriptor, boardHash,
  fetchAsset = fetch, onChange = () => {}, aimAt = () => {} }) {
  const document = container.ownerDocument, controller = new AbortController();
  let plan = null, overlay = null, room = 'all', boardID = null, disposed = false, loading = false, error = '';
  const el = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
  const panel = el('details'), summary = el('summary', 'Lighting & connections');
  const intro = el('p', 'Wired switches now. Smart-ready later. Ceiling and final module counts are not approved.');
  const select = el('select'); select.setAttribute('aria-label', 'Control or appliance relationship');
  const label = el('label', 'Trace one control'); label.append(select);
  const show = el('input'); show.type = 'checkbox'; show.disabled = true;
  const showLabel = el('label'); showLabel.append(show, document.createTextNode('Show relationship lines'));
  const focus = el('button', 'Look at load'); focus.type = 'button'; focus.disabled = true;
  const detail = el('div'), status = el('p', 'Loading functional plan…');
  status.setAttribute('role', 'status');
  const retry = el('button', 'Retry control plan'); retry.type = 'button'; retry.hidden = true;
  const notes = el('details'); notes.append(el('summary', 'Wired-control provisions & limits'));
  panel.className = 'control-connections';
  panel.append(summary, intro, label, showLabel, focus, detail, status, retry, notes); container.prepend(panel);
  const banner = el('aside');
  banner.className = 'connection-banner'; banner.hidden = true;
  const caption = el('span'), hide = el('button', 'Hide lines'); hide.type = 'button';
  banner.append(caption, hide); stage.append(banner);
  const listen = (target, name, action) => target.addEventListener(name, action, { signal: controller.signal });
  function render() {
    const control = plan?.controls.find(control => control.id === select.value);
    const points = control?.group_ids.flatMap(id => plan.groups.find(group => group.id === id).points_web_m) || [];
    focus.disabled = points.length === 0;
    detail.replaceChildren();
    if (control) {
      const board = descriptor.boards.find(board => board.id === control.board_id);
      const groups = control.group_ids.map(id => plan.groups.find(group => group.id === id));
      detail.append(el('h4', `${board.label} → ${control.label}`));
      if (control.lighting_control) {
        const related = [...new Set(plan.controls.filter(other =>
          other.lighting_control && other.group_ids.some(id => control.group_ids.includes(id))).map(other =>
          descriptor.boards.find(board => board.id === other.board_id).label))];
        detail.append(el('p', `Operate from: ${related.join(' · ')}`));
      }
      for (const group of groups) {
        const meaning = group.endpoint_basis === 'functional-zone-only' ? 'Zone only · fittings/position undecided' :
          group.endpoint_basis === 'unresolved' ? 'Endpoint undecided · no line drawn' :
          group.endpoint_basis === 'provisional-accessory' ? 'Accessory reservation · not selected' : 'Modeled body · not a cable terminal';
        detail.append(el('p', `${group.label}: ${meaning}`));
      }
      if (control.lighting_control) detail.append(el('p', 'One on/off function; fitting count and final module size undecided.'));
      if (control.kind === 'isolation-control' && control.group_ids.some(id => id.endsWith('-AC'))) {
        detail.append(el('p', 'AC supply / stabilizer arrangement is deferred. This line does not specify indoor-unit mains wiring.'));
      }
      overlay.select(control.id, show.checked);
      const state = overlay.snapshot();
      banner.hidden = !show.checked;
      caption.textContent = `${control.label} · ${state.segments} dashed link${state.segments === 1 ? '' : 's'} · NOT cable routes`;
    } else { overlay?.setEnabled(false); banner.hidden = true; }
    select.disabled = !control; show.disabled = !control;
    status.textContent = error || (plan ? 'Dashed = relationship, not wiring. Walls still hide lines; transparent furniture reveals concealed equipment.' : 'Loading functional plan…');
    retry.hidden = !error; retry.disabled = loading;
    onChange();
  }
  function filter() {
    const options = plan?.controls.filter(control =>
      (!boardID || control.board_id === boardID) &&
      (room === 'all' || control.room === room || control.group_ids.some(id => plan.groups.find(group => group.id === id)?.room === room))) || [];
    const selected = select.value;
    select.replaceChildren(...options.map(control => new Option(
      `${descriptor.boards.find(board => board.id === control.board_id).label} · ${control.label}`, control.id)));
    if (options.some(control => control.id === selected)) select.value = selected;
    render();
  }
  async function load() {
    if (loading || disposed) return;
    loading = true; error = ''; render();
    try {
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => request.abort(new Error('Control plan loading timed out')), 15000);
      let value;
      try {
        const response = await fetchAsset(new URL('./model/electrical/control-plan.json', document.baseURI),
          { signal: request.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(`Control plan HTTP ${response.status}`);
        value = validateControlPlan(await response.json(), house, descriptor, boardHash);
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
      if (disposed) return;
      plan = value;
      overlay?.dispose(); overlay = createConnectionOverlay(THREE, scene, plan, descriptor.boards);
      notes.replaceChildren(el('summary', 'Wired-control provisions & limits'));
      for (const text of [...plan.requirements, ...plan.drawing_limits]) notes.append(el('p', text));
      filter();
    } catch (cause) {
      if (!disposed) error = `${cause.message} Relationships unavailable; walking and existing boards are unchanged. Retry control plan.`;
    } finally { if (!disposed) { loading = false; render(); } }
  }
  listen(select, 'change', render); listen(show, 'change', render);
  listen(focus, 'click', () => {
    const control = plan?.controls.find(control => control.id === select.value);
    const points = control?.group_ids.flatMap(id => plan.groups.find(group => group.id === id).points_web_m) || [];
    if (points.length) aimAt(points[0]);
  });
  listen(hide, 'click', () => { show.checked = false; render(); });
  listen(retry, 'click', load);
  const ready = load();
  return {
    ready,
    control: id => plan?.controls.find(control => control.id === id),
    group: id => plan?.groups.find(group => group.id === id),
    setRoom(value) { room = value; boardID = null; filter(); },
    setBoard(value) { boardID = value; filter(); },
    snapshot: () => ({ loaded: Boolean(plan), error, ...overlay?.snapshot() }),
    dispose() { disposed = true; controller.abort(); overlay?.dispose(); panel.remove(); banner.remove(); },
  };
}

export { hash as controlPlanHash };
