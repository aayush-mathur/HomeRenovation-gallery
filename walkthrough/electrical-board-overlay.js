import { assertEmbeddedGLB, disposeCeiling } from './ceiling-comparison.js?v=385a64a657a99098';
import { createBoardLabels } from './electrical-board-labels.js?v=5a036b5e030f707f';
import { boardRooms } from './electrical-board-descriptor.js?v=d27cd293eda215a6';

export function createBoardOverlay({ THREE, scene, camera, stage, descriptor, occluderRoots, parse,
  releaseInput = () => {}, isInputBusy = () => false, excludedElements = [], onSelect = () => {},
  onChange = () => {}, fetchAsset = fetch, digest = bytes => crypto.subtle.digest('SHA-256', bytes),
  createLabels = createBoardLabels }) {
  let root = null, labels = null, enabled = false, labelsEnabled = true, disposed = false;
  let loading = false, error = '', selected = null, room = 'all', highlight = null;
  let generation = 0, controller = null, pending = null;
  const nodes = new Map();
  const rooms = new Map(descriptor.boards.map(board => [board.id, boardRooms(board, descriptor.fixture_groups)]));
  const snapshot = () => ({ enabled, labelsEnabled, disposed, loading, error, selected, room,
    overlayLoaded: Boolean(root), boardCount: descriptor.boards.length,
    visibleBoardCount: enabled && root ? [...nodes.values()].filter(node => node.visible).length : 0,
    labels: labels?.snapshot() || { enabled: labelsEnabled, visible: [], hidden: [], selected, disposed } });
  const emit = () => onChange(snapshot());
  function clearHighlight() {
    if (highlight) { scene.remove(highlight); disposeCeiling(highlight); highlight = null; }
  }
  function sync() {
    if (root) root.visible = enabled;
    for (const board of descriptor.boards) {
      const node = nodes.get(board.id);
      if (node) node.visible = room === 'all' || rooms.get(board.id).includes(room);
    }
    labels?.setEnabled(enabled && labelsEnabled);
    labels?.setRoomFilter(room);
    labels?.select(selected);
    clearHighlight();
    const node = selected && nodes.get(selected);
    if (enabled && node?.visible) {
      highlight = new THREE.Box3Helper(new THREE.Box3().setFromObject(node).expandByScalar(.006), 0x225673);
      highlight.name = 'Selected proposed switchboard';
      scene.add(highlight);
    }
    emit();
  }
  function remove() {
    clearHighlight(); labels?.dispose(); labels = null; nodes.clear();
    if (root) { scene.remove(root); disposeCeiling(root); root = null; }
  }
  async function load(ticket, signal) {
    let parsed = null;
    try {
      const response = await fetchAsset(descriptor.model.url, { signal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
      if (!response.ok || response.type === 'opaque') throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (disposed || ticket !== generation) return;
      const hash = [...new Uint8Array(await digest(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (disposed || ticket !== generation) return;
      if (bytes.byteLength !== descriptor.model.bytes || hash !== descriptor.model.sha256) throw new Error('board size or SHA-256 mismatch');
      assertEmbeddedGLB(bytes);
      parsed = (await parse(bytes)).scene;
      if (!parsed) throw new Error('board scene missing');
      if (disposed || ticket !== generation) { disposeCeiling(parsed); parsed = null; return; }
      parsed.updateMatrixWorld(true);
      const validNames = new Set(descriptor.boards.map(board => board.node_name));
      for (const board of descriptor.boards) {
        const matches = [];
        parsed.traverse(node => { if (node.name === board.node_name) matches.push(node); });
        if (matches.length !== 1) throw new Error(`board/catalog mismatch: ${board.id}`);
        const bounds = new THREE.Box3().setFromObject(matches[0]);
        if (bounds.isEmpty() || !bounds.expandByScalar(.02).containsPoint(new THREE.Vector3(...board.position_web_m))) {
          throw new Error(`face anchor does not match actual board: ${board.id}`);
        }
        nodes.set(board.id, matches[0]);
      }
      parsed.traverse(node => {
        if (node.isLight || node.isCamera || node.name.startsWith('REF_')) throw new Error('Non-board content in overlay');
        if (!node.isMesh) return;
        let board = node;
        while (board && !validNames.has(board.name)) board = board.parent;
        if (!board) throw new Error('Unmapped mesh in board overlay');
        node.castShadow = false; node.receiveShadow = true;
      });
      root = parsed; parsed = null; scene.add(root);
      labels = createLabels({ THREE, camera, stage, occluderRoots, releaseInput, isInputBusy, excludedElements,
        boards: descriptor.boards.map(board => ({ id: board.id, text: board.label, room: board.room, servedRooms: rooms.get(board.id),
          anchor: new THREE.Vector3(...board.position_web_m), normal: new THREE.Vector3(...board.normal_web) })),
        onSelect });
      loading = false; controller = null; sync();
    } catch (cause) {
      if (parsed) disposeCeiling(parsed);
      if (disposed || ticket !== generation) return;
      remove(); loading = false; controller = null;
      error = `Switchboards could not load: ${cause.message}. Walking is unchanged. Retry switchboard display.`;
      emit();
    } finally {
      if (ticket === generation) pending = null;
    }
  }
  function reconcile() {
    if (disposed) return Promise.resolve();
    if (!enabled) {
      ++generation; controller?.abort(); controller = null; pending = null; loading = false; error = '';
      sync(); return Promise.resolve();
    }
    if (root) { sync(); return Promise.resolve(); }
    if (pending) return pending;
    const ticket = ++generation;
    controller = new AbortController();
    loading = true; error = ''; emit();
    const signal = controller.signal;
    pending = Promise.resolve().then(() => {
      if (!disposed && ticket === generation) return load(ticket, signal);
    });
    return pending;
  }
  return {
    snapshot,
    setEnabled(value) { if (disposed) return Promise.resolve(); enabled = Boolean(value); return reconcile(); },
    setLabels(value) { if (!disposed) { labelsEnabled = Boolean(value); sync(); } },
    setRoom(value) { if (!disposed) { room = value; sync(); } },
    selectBoard(id) {
      if (disposed) return;
      if (id !== null && !descriptor.boards.some(board => board.id === id)) throw new Error('Unknown proposed switchboard');
      selected = id; sync();
    },
    pickLabel(x, y) { return labels?.pick(x, y) || null; },
    update({ time, currentRoom, paused = false }) {
      if (!labels || disposed) return;
      const before = labels.snapshot().visible.length;
      labels.update({ time, room: currentRoom, paused });
      if (before !== labels.snapshot().visible.length) emit();
    },
    retry: reconcile,
    cancelPending(message) {
      if (!loading || disposed) return;
      ++generation; controller?.abort(); controller = null; pending = null; loading = false;
      error = `${message} Walking is available. Retry switchboard display.`; emit();
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; ++generation; controller?.abort(); controller = null;
      pending = null; loading = false; remove(); emit();
    },
  };
}
