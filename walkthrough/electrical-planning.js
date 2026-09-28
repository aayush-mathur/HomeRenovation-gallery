import { GLTFLoader } from './vendor/GLTFLoader.js';
import { assertEmbeddedGLB, disposeCeiling } from './ceiling-comparison.js';

const HASH = /^[a-f0-9]{64}$/;
const STATES = ['proposed', 'reference-only', 'unplaced'];
const BACKUP = ['requested', 'mains-only', 'not-decided'];
const POINT_FIELDS = ['id', 'label', 'function', 'room', 'height_aff_mm', 'state', 'backup_preference'];
const TOP_FIELDS = ['version', 'id', 'base_source_sha256', 'base_navigation_sha256', 'ceiling_compatibility', 'model', 'points'];
const ROOM_LABELS = {
  bedroom_1: 'Back bedroom', bedroom_2: 'Middle bedroom', bedroom_3: 'Front bedroom',
  lounge: 'Family hall / mandir / media', drawing: 'Drawing room', dining: 'Dining and dock',
  kitchen: 'Kitchen and RO', lobby: 'Entry lobby', bathroom_1: 'Rear bathroom',
  bathroom_2: 'Middle bathroom', bathroom_3: 'Front bathroom', dressing_3: 'Front dressing',
};
const sameFields = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');

export function validateElectricalDescriptor(value, house, baseURL) {
  const fail = detail => { throw new Error(`Electrical planning unavailable: ${detail}`); };
  if (!sameFields(value, TOP_FIELDS) || value.version !== 1 || value.id !== 'electrical-v002') fail('unsupported descriptor');
  if (!HASH.test(value.base_source_sha256) || !HASH.test(value.base_navigation_sha256) ||
      value.base_source_sha256 !== house.source_sha256 || value.base_navigation_sha256 !== house.navigation_sha256) {
    fail('the points do not match this house/navigation revision');
  }
  const ceilings = ['existing', 'quiet', 'linear', 'warm', 'sculpted', 'luxe'];
  if (!Array.isArray(value.ceiling_compatibility) || value.ceiling_compatibility.join('|') !== ceilings.join('|')) fail('unsupported ceiling binding');
  const model = value.model;
  if (!sameFields(model, ['src', 'sha256', 'bytes']) || !HASH.test(model.sha256) ||
      !Number.isSafeInteger(model.bytes) || model.bytes <= 0 || model.bytes > 5_000_000 ||
      model.src !== `./model/electrical/plates-${model.sha256.slice(0, 16)}.glb`) fail('invalid or unsafe overlay asset');
  const base = new URL(baseURL), url = new URL(model.src, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(new URL('./model/electrical/', base).pathname)) fail('asset escapes walkthrough scope');
  if (!Array.isArray(value.points) || value.points.length !== 100) fail('incomplete point catalog');
  const ids = new Set();
  for (const p of value.points) {
    if (!sameFields(p, POINT_FIELDS) || !/^E-[A-Z0-9]{2,3}-\d{2}$/.test(p.id) || ids.has(p.id) ||
        !Object.hasOwn(ROOM_LABELS, p.room) || !STATES.includes(p.state) || !BACKUP.includes(p.backup_preference) ||
        !['label', 'function'].every(key => typeof p[key] === 'string' && p[key].length > 0 && p[key].length <= 160) ||
        (p.state === 'proposed' ? !Number.isInteger(p.height_aff_mm) || p.height_aff_mm < 100 || p.height_aff_mm > 2500 : p.height_aff_mm !== null)) {
      fail('invalid or extraneous point metadata');
    }
    ids.add(p.id);
  }
  if (value.points.filter(p => p.state === 'proposed').length !== 57 ||
      value.points.filter(p => p.state === 'reference-only').length !== 38 ||
      value.points.filter(p => p.state === 'unplaced').length !== 5) fail('unexpected placement states');
  return { ...value, model: { ...model, url: url.href }, points: value.points.map(p => ({ ...p })) };
}

export function createElectricalOverlay({ THREE, scene, descriptor, parse,
  fetchAsset = fetch, digest = bytes => crypto.subtle.digest('SHA-256', bytes), onChange = () => {} }) {
  let disposed = false, enabled = false, loading = false, error = '', root = null, abort = null, ticket = 0, pending = null;
  let room = 'all', filter = 'all', selected = null, showReferences = false, highlight = null;
  let visiblePlateCount = 0, visibleReferenceCount = 0, matchingPlateCount = 0, matchingReferenceCount = 0;
  const nodes = new Map(), referenceLines = new Map();
  const snapshot = () => ({ enabled, loading, error, disposed, room, filter, selected, showReferences,
    overlayLoaded: Boolean(root), plateCount: root ? 57 : 0, referenceCount: referenceLines.size,
    visiblePlateCount, visibleReferenceCount, matchingPlateCount, matchingReferenceCount });
  const emit = () => onChange(snapshot());
  const clearHighlight = () => {
    if (highlight) { scene.remove(highlight); disposeCeiling(highlight); highlight = null; }
  };
  function updateVisibility() {
    if (root) root.visible = enabled;
    visiblePlateCount = visibleReferenceCount = matchingPlateCount = matchingReferenceCount = 0;
    for (const p of descriptor.points) {
      const matches = (room === 'all' || room === p.room) && (filter === 'all' || filter === p.state);
      if (matches && p.state === 'proposed') matchingPlateCount++;
      if (matches && p.state === 'reference-only') matchingReferenceCount++;
      const node = nodes.get(p.id);
      if (!node) continue;
      node.visible = enabled && p.state === 'proposed' && matches;
      if (node.visible) visiblePlateCount++;
      const line = referenceLines.get(p.id);
      if (line) {
        line.visible = showReferences && matches;
        if (line.visible) visibleReferenceCount++;
      }
    }
    clearHighlight();
    if (selected && root) {
      const p = descriptor.points.find(p => p.id === selected);
      const node = p?.state === 'proposed' ? nodes.get(selected) : referenceLines.get(selected);
      if (node?.visible) {
        const bounds = new THREE.Box3().setFromObject(node);
        if (!bounds.isEmpty()) {
          bounds.expandByScalar(.007);
          highlight = new THREE.Box3Helper(bounds, 0x225673);
          if (p.state === 'reference-only') {
            highlight.material.depthTest = false;
            highlight.material.depthWrite = false;
            highlight.material.transparent = true;
            highlight.material.toneMapped = false;
            highlight.renderOrder = 1001;
          }
          scene.add(highlight);
        }
      }
    }
  }
  function remove() {
    clearHighlight();
    for (const line of referenceLines.values()) { scene.remove(line); disposeCeiling(line); }
    referenceLines.clear(); nodes.clear();
    if (root) { scene.remove(root); disposeCeiling(root); root = null; }
    visiblePlateCount = visibleReferenceCount = 0;
  }
  function referenceLine(node) {
    const box = new THREE.BoxGeometry(.13, .13, .13);
    const geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    const material = new THREE.LineDashedMaterial({ color: 0x9b641c, dashSize: .020, gapSize: .012,
      depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    const line = new THREE.LineSegments(geometry, material);
    line.name = `REFERENCE_ONLY_${node.name}`;
    node.getWorldPosition(line.position);
    line.computeLineDistances();
    line.renderOrder = 1000;
    line.visible = false;
    return line;
  }
  function reconcile() {
    if (disposed) return Promise.resolve();
    if (!enabled && !showReferences) {
      ++ticket; abort?.abort(); abort = null; pending = null; loading = false; error = '';
      updateVisibility(); emit(); return Promise.resolve();
    }
    if (root) { updateVisibility(); emit(); return Promise.resolve(); }
    if (pending) { updateVisibility(); emit(); return pending; }
    const generation = ++ticket;
    const controller = new AbortController(); abort = controller;
    loading = true; error = ''; updateVisibility(); emit();
    pending = Promise.resolve().then(() => load(generation, controller));
    return pending;
  }
  async function load(generation, controller) {
    if (disposed || generation !== ticket) return;
    let loaded = null;
    try {
      const response = await fetchAsset(descriptor.model.url, { signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (disposed || generation !== ticket) return;
      if (bytes.byteLength !== descriptor.model.bytes || hex(await digest(bytes)) !== descriptor.model.sha256) throw new Error('overlay size or SHA-256 does not match');
      if (disposed || generation !== ticket) return;
      assertEmbeddedGLB(bytes);
      loaded = (await parse(bytes)).scene;
      if (!loaded) throw new Error('overlay scene missing');
      if (disposed || generation !== ticket) { disposeCeiling(loaded); loaded = null; return; }
      for (const p of descriptor.points) {
        if (p.state === 'unplaced') continue;
        const expected = (p.state === 'proposed' ? 'POINT_' : 'REF_') + p.id;
        const matches = [];
        loaded.traverse(obj => { if (obj.name === expected) matches.push(obj); });
        if (matches.length !== 1) throw new Error(`overlay/catalog mismatch at ${p.id}`);
        nodes.set(p.id, matches[0]);
      }
      loaded.traverse(obj => {
        if (obj.isLight || obj.isCamera) throw new Error('overlay must not contain lights or cameras');
        if (obj.isMesh) { obj.castShadow = false; obj.receiveShadow = true; }
      });
      root = loaded; loaded = null; scene.add(root); root.updateMatrixWorld(true);
      for (const p of descriptor.points) {
        if (p.state !== 'reference-only') continue;
        const line = referenceLine(nodes.get(p.id));
        referenceLines.set(p.id, line); scene.add(line);
      }
      loading = false; abort = null; updateVisibility(); emit();
    } catch (cause) {
      if (loaded) disposeCeiling(loaded);
      if (disposed || generation !== ticket) return;
      remove(); loading = false; abort = null;
      error = `Could not show electrical planning: ${cause.message}. Walking and the selected ceiling are unchanged. Retry electrical display.`;
      emit();
    } finally {
      if (generation === ticket) pending = null;
    }
  }
  return {
    setEnabled(value) { if (disposed) return Promise.resolve(); enabled = Boolean(value); return reconcile(); },
    setReferences(value) { if (disposed) return Promise.resolve(); showReferences = Boolean(value); return reconcile(); },
    retry() { return reconcile(); },
    cancelPending(message) {
      if (!loading || disposed) return;
      ++ticket; abort?.abort(); abort = null; pending = null; loading = false;
      error = `${message} Walking is available. Retry electrical display.`;
      updateVisibility(); emit();
    },
    snapshot,
    setRoom(value) { if (!disposed) { room = value; updateVisibility(); emit(); } },
    setStateFilter(value) { if (!disposed) { filter = value; updateVisibility(); emit(); } },
    selectPoint(id) {
      if (disposed) return;
      if (id !== null && !descriptor.points.some(p => p.id === id)) throw new Error('Unknown electrical point');
      selected = id; updateVisibility(); emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; showReferences = false; ++ticket; abort?.abort(); abort = null; pending = null; loading = false;
      remove(); emit();
    },
  };
}

export function initElectricalPlanning({ THREE, scene, container, houseDescriptor, releaseInput = () => {},
  fetchAsset = fetch, parse = bytes => new GLTFLoader().parseAsync(bytes, ''), initialPlates = false }) {
  if (!container) throw new Error('Electrical planning requires a dedicated control host');
  const listeners = new AbortController();
  let disposed = false, descriptor = null, overlay = null, initError = '', room = 'all', filter = 'all', initializing = false;
  let definitionController = null, definitionTicket = 0;
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const panel = el('details', null, { class: 'electrical-planning' });
  const summary = el('summary', 'Electrical planning · proposed');
  panel.append(summary);
  const content = el('div', null, { class: 'electrical-planning-content' });
  const notice = el('p', 'Visible fittings are proposals, not selected/rated products. No wiring or installation approval.');
  const enabled = el('input', null, { type: 'checkbox', 'aria-label': 'Show proposed electrical plates' });
  enabled.disabled = true;
  const toggle = el('label', ''); toggle.append(enabled, document.createTextNode('Show proposed plates'));
  const references = el('input', null, { type: 'checkbox', 'aria-label': 'Show equipment markers (not socket positions)' });
  references.disabled = true;
  const refLabel = el('label'); refLabel.append(references, document.createTextNode('Show equipment markers (not socket positions)'));
  const rooms = el('select', null, { 'aria-label': 'Electrical room' });
  const states = el('select', null, { 'aria-label': 'Electrical placement state' });
  const list = el('select', null, { 'aria-label': 'Electrical point' });
  const filters = el('div', null, { class: 'electrical-planning-filters' });
  const roomLabel = el('label', 'Room'); roomLabel.append(rooms);
  const stateLabel = el('label', 'Placement'); stateLabel.append(states);
  filters.append(roomLabel, stateLabel);
  const detail = el('div', null, { class: 'electrical-point-detail', 'aria-live': 'polite' });
  const status = el('p', 'Loading point definitions…', { class: 'electrical-planning-status', role: 'status' });
  const retry = el('button', 'Retry electrical definitions', { type: 'button' }); retry.hidden = true;
  rooms.append(new Option('All rooms', 'all'));
  for (const [id, label] of Object.entries(ROOM_LABELS)) rooms.append(new Option(label, id));
  for (const [id, label] of [['all','Everything'],['proposed','Suggested switches & sockets'],['reference-only','Equipment needing power'],['unplaced','Location not decided']]) states.append(new Option(label,id));
  content.append(notice, toggle, refLabel,
    el('p', 'Markers can show through equipment/walls. They locate equipment needing power, not socket positions or installation heights.'),
    filters, list, detail, status, retry,
    el('p', 'USB-C modules are provisional: product and output/PD unspecified. Ordinary sockets remain available; no permanently buried chargers.'),
    el('p', 'Backup is a preference, not a circuit or capacity result. Selected lights/fans/Wi-Fi/charging only. Mains-only workstation/counter points stay mains-only. AFF is above the modeled floor; actual products, reach and wet-area protection need qualified review.'));
  panel.append(content); container.replaceChildren(panel);
  const on = (target, name, callback) => target.addEventListener(name, callback, { signal: listeners.signal });
  on(panel, 'pointerdown', releaseInput); on(panel, 'focusin', releaseInput);
  function render(state = overlay?.snapshot()) {
    if (disposed) return;
    enabled.checked = Boolean(state?.enabled);
    references.checked = Boolean(state?.showReferences);
    enabled.disabled = !descriptor;
    references.disabled = !descriptor;
    const counts = `${state?.visiblePlateCount || 0} suggested plates and ${state?.visibleReferenceCount || 0} equipment markers enabled in the scene (not necessarily on screen).`;
    let explanation = '';
    if (state?.showReferences && !state.visibleReferenceCount && !state.loading && !state.error) {
      explanation = state.filter === 'proposed' || state.filter === 'unplaced'
        ? ' Equipment markers are hidden by Placement. Choose Everything or Equipment needing power.'
        : ' No equipment markers match this room. Choose All rooms or another room.';
    } else if (state?.enabled && !state.visiblePlateCount && !state.loading && !state.error) {
      explanation = state.filter === 'reference-only' || state.filter === 'unplaced'
        ? ' Suggested plates are hidden by Placement. Choose Everything or Suggested switches & sockets.'
        : ' No suggested plates match this room. Choose All rooms or another room.';
    }
    status.textContent = initError || state?.error || (state?.loading
      ? 'Loading verified electrical display for the selected toggles…'
      : `${counts}${explanation}${!state?.enabled && !state?.showReferences ? ' Both display toggles are off.' : ''}`);
    status.dataset.error = String(Boolean(initError || state?.error));
    summary.textContent = initError || state?.error ? 'Electrical planning · needs retry' : 'Electrical planning · proposed';
    retry.hidden = !initError && !state?.error;
    retry.disabled = initializing || Boolean(state?.loading);
    retry.textContent = descriptor ? 'Retry electrical display' : 'Retry electrical definitions';
    const p = descriptor?.points.find(p => p.id === state?.selected);
    detail.replaceChildren();
    if (!p) { detail.append(el('p', 'Choose a point from the list. Room and placement filters keep the view uncluttered.')); return; }
    detail.append(el('h3', `${p.id} · ${p.label}`), el('p', p.function));
    detail.append(el('p', p.state === 'proposed' ? `PROPOSED · ${p.height_aff_mm} mm AFF · ${ROOM_LABELS[p.room]}` :
      p.state === 'reference-only' ? 'EQUIPMENT NEEDING POWER — reference only, not an approved socket or installation height.' :
      'LOCATION NOT DECIDED — no invented position or visible fitting.'));
    detail.append(el('p', p.backup_preference === 'requested' ? 'Backup requested — capacity and final circuits pending.' :
      p.backup_preference === 'mains-only' ? 'Mains-only — not included in selected charging/essential backup.' :
      'Backup not decided. A bathroom control may combine requested light and undecided exhaust functions; no shared circuit assumed.'));
    if (p.state === 'reference-only') detail.append(el('p', 'Qualified installer to resolve wet-area/product placement and protection. No receptacle is proposed at this locator.'));
    if (p.state === 'proposed' && !state.enabled) detail.append(el('p', 'Show proposed plates to highlight this point; the house view will not move.'));
    if (p.state === 'reference-only') detail.append(el('p', state.showReferences
      ? 'The selected equipment marker and outline can show through equipment/walls.'
      : 'Turn on Show equipment markers to see and highlight this equipment, independently of the plates.'));
  }
  function updateList() {
    const selected = overlay?.snapshot().selected;
    const points = descriptor?.points.filter(p => (room === 'all' || p.room === room) && (filter === 'all' || p.state === filter)) || [];
    list.replaceChildren(new Option(points.length ? 'Choose a point…' : 'No matching points', ''),
      ...points.map(p => new Option(`${p.id} · ${p.label}${p.state === 'reference-only' ? ' · equipment needing power' : p.state === 'unplaced' ? ' · location not decided' : ''}`, p.id)));
    list.value = points.some(p => p.id === selected) ? selected : '';
    if (!list.value && selected) overlay?.selectPoint(null);
  }
  async function initialize() {
    if (initializing || disposed) return;
    initializing = true; retry.hidden = true; retry.disabled = true; initError = '';
    const generation = ++definitionTicket;
    definitionController = new AbortController();
    try {
      const response = await fetchAsset(new URL('./model/electrical/manifest.json', document.baseURI), { signal: definitionController.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(`definitions HTTP ${response.status}`);
      const value = await response.json();
      if (disposed || generation !== definitionTicket) return;
      descriptor = validateElectricalDescriptor(value, houseDescriptor, document.baseURI);
      overlay = createElectricalOverlay({ THREE, scene, descriptor, parse, fetchAsset, onChange: render });
      updateList(); render();
      if (initialPlates) await overlay.setEnabled(true);
    } catch (cause) {
      if (disposed || generation !== definitionTicket) return;
      initError = `${cause.message}. Electrical overlay disabled; ordinary walking is unchanged.`;
    } finally {
      if (generation === definitionTicket) { initializing = false; render(); }
    }
  }
  const ready = initialize();
  on(enabled, 'change', () => overlay?.setEnabled(enabled.checked));
  on(references, 'change', () => overlay?.setReferences(references.checked));
  on(rooms, 'change', () => { room = rooms.value; overlay?.setRoom(room); updateList(); });
  on(states, 'change', () => { filter = states.value; overlay?.setStateFilter(filter); updateList(); });
  on(list, 'change', () => overlay?.selectPoint(list.value || null));
  on(retry, 'click', () => descriptor ? overlay?.retry() : initialize());
  return {
    ready,
    async setEnabled(value) { await ready; if (!disposed) await overlay?.setEnabled(value); },
    async setReferences(value) { await ready; if (!disposed) await overlay?.setReferences(value); },
    cancelPending(message) {
      if (disposed) return;
      if (initializing && !descriptor) {
        ++definitionTicket; definitionController?.abort(); initializing = false;
        initError = `${message} Walking is available. Retry electrical definitions.`;
        render();
      }
      if (descriptor) initializing = false;
      overlay?.cancelPending(message);
    },
    setRoom(value) { room = value; rooms.value = value; overlay?.setRoom(value); updateList(); },
    setStateFilter(value) { filter = value; states.value = value; overlay?.setStateFilter(value); updateList(); },
    selectPoint(id) { overlay?.selectPoint(id); list.value = id || ''; },
    snapshot: () => overlay?.snapshot() || { enabled: false, loading: false, disposed, error: initError, overlayLoaded: false },
    dispose() { if (disposed) return; disposed = true; ++definitionTicket; definitionController?.abort(); listeners.abort(); overlay?.dispose(); container.replaceChildren(); },
  };
}
