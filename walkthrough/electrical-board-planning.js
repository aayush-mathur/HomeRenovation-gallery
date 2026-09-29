import { GLTFLoader } from './vendor/GLTFLoader.js';
import { validateBoardDescriptor, boardRooms } from './electrical-board-descriptor.js?v=d27cd293eda215a6';
import { createBoardOverlay } from './electrical-board-overlay.js?v=b59d20a148989792';

const ROOM_LABELS = {
  bedroom_1: 'Back bedroom', bedroom_2: 'Middle bedroom', bedroom_3: 'Front bedroom',
  drawing: 'Drawing room', lounge: 'Hall', dining: 'Dining', kitchen: 'Kitchen',
  lobby: 'Entry lobby', bathroom_1: 'Rear bathroom', bathroom_2: 'Middle bathroom',
  bathroom_3: 'Front bathroom', dressing_3: 'Front dressing', utility: 'Utility', rear_ots: 'Rear OTS',
};
const BACKUP_LABELS = {
  requested: 'Backup requested',
  'mains-only': 'Mains-only preference',
  'not-decided': 'Backup not decided',
};
const SOURCE_LABELS = {
  'india-framework': 'India framework',
  'manufacturer-guidance': 'Manufacturer guidance',
  'international-reference': 'International design reference, not an Indian installation rule',
  'project-assumption': 'Project assumption, subject to site verification',
};

export function initBoardPlanning({ THREE, scene, camera, stage, model, container, houseDescriptor,
  releaseInput = () => {}, isInputBusy = () => false, revealControls = () => {},
  initialPlates = true, fetchAsset = fetch, parse = bytes => new GLTFLoader().parseAsync(bytes, '') }) {
  if (!container || !stage || !model) throw new Error('Switchboard planning requires its viewer mount and house model');
  const document = container.ownerDocument, listeners = new AbortController();
  let disposed = false, descriptor = null, overlay = null, selected = null, room = 'all', category = 'boards';
  let error = '', initializing = false, definitionController = null, definitionTicket = 0, detailKey = '';
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const panel = el('details', null, { class: 'electrical-planning' });
  const summary = el('summary', 'Switchboards · proposed');
  const content = el('div', null, { class: 'electrical-planning-content' });
  const plates = el('input', null, { type: 'checkbox', 'aria-label': 'Show proposed switchboards' });
  const labels = el('input', null, { type: 'checkbox', 'aria-label': 'Show nearby switchboard labels' });
  labels.checked = true; plates.disabled = labels.disabled = true;
  const plateLabel = el('label'); plateLabel.append(plates, document.createTextNode('Show proposed switchboards'));
  const labelLabel = el('label'); labelLabel.append(labels, document.createTextNode('Show nearby switchboard labels'));
  const rooms = el('select', null, { 'aria-label': 'Switchboard room or served room' });
  const categories = el('select', null, { 'aria-label': 'Electrical design list' });
  rooms.append(new Option('All rooms', 'all'));
  for (const [id, label] of Object.entries(ROOM_LABELS)) rooms.append(new Option(label, id));
  categories.append(new Option('Proposed switchboards', 'boards'), new Option('Needs still to resolve (list only)', 'requirements'));
  const filters = el('div', null, { class: 'electrical-planning-filters' });
  const roomLabel = el('label', 'Room / served room'); roomLabel.append(rooms);
  const categoryLabel = el('label', 'Design list'); categoryLabel.append(categories); filters.append(roomLabel, categoryLabel);
  const list = el('select', null, { 'aria-label': 'Switchboard or unresolved need' });
  const detail = el('div', null, { class: 'electrical-point-detail', 'aria-live': 'polite' });
  const status = el('p', 'Loading source-bound board design…', { class: 'electrical-planning-status', role: 'status' });
  const retry = el('button', 'Retry switchboard definitions', { type: 'button' }); retry.hidden = true;
  content.append(el('p', 'Proposed switchboards, not a wiring or installation plan. Lighting names describe Sculpted Luxe; controls are not simulated. Labels attach to physical boards and never show through walls.'),
    plateLabel, labelLabel,
    el('p', 'Nearby visible boards are labelled. Tap without dragging to read a board; drag to look as usual. While walking or looking, labels do not intercept pointer input. The list also reaches boards outside your view.'),
    filters, list, detail, status, retry,
    el('p', 'Module arrangement, product ratings, backup capacity, wiring, wet-area protection and installation require qualified local review. A reason or reference below is not approval.'));
  panel.append(summary, content); container.replaceChildren(panel);
  const on = (target, name, callback) => target.addEventListener(name, callback, { signal: listeners.signal });
  on(panel, 'pointerdown', releaseInput); on(panel, 'focusin', releaseInput);
  function showReasons(reasonIDs) {
    detail.append(el('h4', 'Why here'));
    const sourceIDs = new Set();
    const constraints = [];
    for (const id of reasonIDs) {
      const reason = descriptor.reasons.find(item => item.id === id);
      detail.append(el('p', reason.summary));
      constraints.push(...reason.constraints);
      for (const source of reason.source_ids) sourceIDs.add(source);
    }
    const sources = el('details', null, { class: 'electrical-design-sources' });
    sources.append(el('summary', 'Design sources, assumptions and checks'));
    if (constraints.length) {
      const list = el('ul');
      for (const text of [...new Set(constraints)]) list.append(el('li', text));
      sources.append(list);
    }
    for (const id of sourceIDs) {
      const source = descriptor.sources.find(item => item.id === id);
      const paragraph = el('p');
      if (source.url) paragraph.append(el('a', source.title, { href: source.url, target: '_blank', rel: 'noopener noreferrer' }));
      else paragraph.append(document.createTextNode(source.title));
      paragraph.append(document.createTextNode(` — ${SOURCE_LABELS[source.classification]}`));
      sources.append(paragraph);
    }
    sources.append(el('p', 'External source links require internet; this placement reasoning remains available in the saved viewer.'));
    detail.append(sources);
  }
  function renderDetail() {
    detail.replaceChildren();
    if (!descriptor || !selected) {
      detail.append(el('p', 'Choose a board label or list entry to see each control, served fixtures and the recorded reason for its position.'));
      return;
    }
    const board = descriptor.boards.find(item => item.id === selected);
    const requirement = descriptor.requirements.find(item => item.id === selected);
    if (!board && !requirement) return;
    const item = board || requirement;
    detail.append(el('h3', `${item.label} · ${item.id}`, { tabindex: '-1' }));
    if (board) {
      detail.append(el('p', `Proposed board · ${ROOM_LABELS[board.room]} · ${board.height_aff_mm} mm above the modelled floor`),
        el('p', `Illustrative face ${board.size_mm[0]} × ${board.size_mm[1]} mm; product and final module sizing remain unselected.`),
        el('h4', 'Controls, left to right'));
      const controls = el('ol', null, { class: 'electrical-board-functions' });
      const behaviors = el('details', null, { class: 'electrical-design-sources' });
      behaviors.append(el('summary', 'Desired control behavior and limits'));
      for (const control of [...board.functions].sort((a, b) => a.slot - b.slot)) {
        const li = el('li');
        li.append(el('strong', control.label));
        const groups = control.fixture_group_ids.map(id => descriptor.fixture_groups.find(item => item.id === id));
        if (groups.length) li.append(el('p', `Serves: ${groups.map(group => group.label).join(' + ')}`));
        li.append(el('p', BACKUP_LABELS[control.backup_preference]));
        behaviors.append(el('p', `${control.label}: ${control.behavior}`));
        controls.append(li);
      }
      detail.append(controls, behaviors);
    } else {
      detail.append(el('p', requirement.state === 'installer-placement-required'
        ? 'Installer placement required — list only; no invented socket, board or on-screen location.'
        : 'Not in the current layout — list only; no invented physical location.'));
    }
    showReasons(item.reason_ids);
  }
  function render(state = overlay?.snapshot()) {
    if (disposed) return;
    plates.disabled = labels.disabled = !descriptor;
    plates.checked = Boolean(state?.enabled);
    labels.checked = state?.labelsEnabled ?? true;
    const failure = error || state?.error;
    summary.textContent = failure ? 'Switchboards · needs retry' : 'Switchboards · proposed';
    retry.hidden = !failure; retry.disabled = initializing || Boolean(state?.loading);
    retry.textContent = descriptor ? 'Retry switchboard display' : 'Retry switchboard definitions';
    status.dataset.error = String(Boolean(failure));
    const count = state?.labels.visible.length || 0;
    status.textContent = failure || (state?.loading ? 'Loading verified switchboard geometry…' :
      `${state?.visibleBoardCount || 0} proposed boards enabled in the scene; ${count} nearby labels visible.${!state?.enabled ? ' Board display is off.' : !state?.labelsEnabled ? ' Labels are hidden.' : panel.open ? ' Labels pause while this panel is open.' : count === 0 ? ' Boards may be outside your room/view, behind geometry, or hidden by the room filter; use the list without moving the camera.' : ''}`);
    const key = `${selected}|${Boolean(descriptor)}`;
    if (key !== detailKey) { detailKey = key; renderDetail(); }
  }
  function choose(id, open = false) {
    selected = id;
    const board = descriptor?.boards.find(item => item.id === id);
    overlay?.selectBoard(board ? id : null);
    if (open) {
      if (room !== 'all' && board && !boardRooms(board, descriptor.fixture_groups).includes(room)) room = board.room;
      category = 'boards'; rooms.value = room; categories.value = category;
      overlay?.setRoom(room);
      revealControls(); panel.open = true;
    }
    updateList(); render();
    if (open) {
      content.scrollTop += detail.getBoundingClientRect().top - content.getBoundingClientRect().top - 12;
      detail.querySelector('h3')?.focus({ preventScroll: true });
    }
  }
  function updateList() {
    const items = descriptor?.[category].filter(item => room === 'all' ||
      (category === 'boards' ? boardRooms(item, descriptor.fixture_groups).includes(room) : item.room === room)) || [];
    list.replaceChildren(new Option(items.length ? 'Choose a board or need…' : 'No matching entries', ''),
      ...items.map(item => new Option(`${item.label} · ${item.id}`, item.id)));
    if (!items.some(item => item.id === selected)) { selected = null; overlay?.selectBoard(null); }
    list.value = selected || '';
  }
  async function initialize() {
    if (initializing || disposed) return;
    initializing = true; error = ''; retry.disabled = true; retry.hidden = true;
    definitionController = new AbortController();
    const ticket = ++definitionTicket;
    try {
      const response = await fetchAsset(new URL('./model/electrical/manifest.json', document.baseURI),
        { signal: definitionController.signal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
      if (!response.ok) throw new Error(`definitions HTTP ${response.status}`);
      const value = await response.json();
      if (disposed || ticket !== definitionTicket) return;
      descriptor = validateBoardDescriptor(value, houseDescriptor, document.baseURI);
      overlay = createBoardOverlay({ THREE, scene, camera, stage, descriptor, occluderRoots: [model], parse, fetchAsset,
        releaseInput, isInputBusy, onSelect: id => choose(id, true), onChange: render,
        excludedElements: [document.getElementById('touch-pad'), document.getElementById('toggle-controls')] });
      updateList(); render();
      if (initialPlates) await overlay.setEnabled(true);
    } catch (cause) {
      if (disposed || ticket !== definitionTicket) return;
      error = `${cause.message}. Switchboard planning is unavailable; ordinary walking is unchanged.`;
    } finally {
      if (ticket === definitionTicket) { initializing = false; render(); }
    }
  }
  on(plates, 'change', () => overlay?.setEnabled(plates.checked));
  on(panel, 'toggle', () => render());
  on(labels, 'change', () => overlay?.setLabels(labels.checked));
  on(rooms, 'change', () => { room = rooms.value; overlay?.setRoom(room); updateList(); render(); });
  on(categories, 'change', () => { category = categories.value; updateList(); render(); });
  on(list, 'change', () => choose(list.value || null));
  on(retry, 'click', () => descriptor ? overlay?.retry() : initialize());
  const ready = initialize();
  return {
    ready,
    update({ time, currentRoom, paused = false }) { overlay?.update({ time, currentRoom, paused: paused || panel.open }); },
    pickLabel(x, y) { return panel.open ? null : overlay?.pickLabel(x, y) || null; },
    selectLabel(id) { if (descriptor?.boards.some(board => board.id === id)) choose(id, true); },
    snapshot: () => overlay?.snapshot() || { enabled: false, loading: initializing, error, disposed, overlayLoaded: false },
    cancelPending(message) {
      if (disposed) return;
      if (initializing && !descriptor) {
        ++definitionTicket; definitionController?.abort(); initializing = false;
        error = `${message} Walking is available. Retry switchboard definitions.`; render();
      }
      if (descriptor) initializing = false;
      overlay?.cancelPending(message);
    },
    dispose() {
      if (disposed) return;
      disposed = true; ++definitionTicket; definitionController?.abort(); listeners.abort();
      overlay?.dispose(); container.replaceChildren();
    },
  };
}
