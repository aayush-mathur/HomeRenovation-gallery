// This view adapter accepts validated physical board anchors, never equipment references.
export function projectBoardLabels({ THREE, boards, camera, width, height, room, selected = null,
  maxDistance = 4.5, nearbyDistance = 2.5, maxLabels = 6, occluded = () => false, excludedRects = [], labelWidth = 164,
  labelHeight = 44 }) {
  if (width <= 0 || height <= 0) return { visible: [], hidden: boards.map(board => ({ id: board.id, reason: 'viewport' })) };
  camera.updateMatrixWorld();
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const candidates = [], hidden = [];
  for (const board of boards) {
    const hide = reason => hidden.push({ id: board.id, reason });
    const direction = origin.clone().sub(board.anchor);
    const distance = direction.length();
    if (distance > maxDistance || distance < .04) { hide('distance'); continue; }
    if (board.room !== room && !board.servedRooms?.includes(room) && distance > nearbyDistance) { hide('room-distance'); continue; }
    if (direction.dot(board.normal) / distance <= .05) { hide('back-face'); continue; }
    const projected = board.anchor.clone().project(camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) {
      hide('frustum'); continue;
    }
    const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
    const box = { x: x - labelWidth / 2, y: y - labelHeight - 10, width: labelWidth, height: labelHeight };
    if (box.x < 8 || box.y < 8 || box.x + box.width > width - 8 || y > height - 8) {
      hide('edge'); continue;
    }
    const whole = { ...box, height: box.height + 14 };
    if (excludedRects.some(rect => overlaps(whole, rect, 6))) { hide('control'); continue; }
    candidates.push({ id: board.id, board, x, y, box, whole, distance });
  }
  candidates.sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || a.distance - b.distance || a.id.localeCompare(b.id));
  const visible = [];
  for (const candidate of candidates) {
    if (visible.length >= maxLabels) { hidden.push({ id: candidate.id, reason: 'budget' }); continue; }
    if (visible.some(other => overlaps(candidate.whole, other.whole, 8))) {
      hidden.push({ id: candidate.id, reason: 'overlap' }); continue;
    }
    const faceTarget = candidate.board.anchor.clone().addScaledVector(candidate.board.normal, .008);
    if (occluded(origin, faceTarget)) { hidden.push({ id: candidate.id, reason: 'occluded' }); continue; }
    visible.push(candidate);
  }
  return { visible, hidden };
}

function overlaps(a, b, gap) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function isVisible(object) {
  for (let current = object; current; current = current.parent) if (!current.visible) return false;
  return true;
}

export function createBoardOcclusion(THREE, roots) {
  const meshes = [];
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse(object => {
      if (object.isMesh) meshes.push({ object, bounds: new THREE.Box3().setFromObject(object) });
    });
  }
  const raycaster = new THREE.Raycaster(), ray = new THREE.Ray(), hit = new THREE.Vector3();
  return (origin, anchor) => {
    const direction = anchor.clone().sub(origin), distance = direction.length();
    if (distance < .04) return false;
    direction.normalize();
    ray.set(origin, direction);
    const relevant = meshes.filter(({ object, bounds }) => isVisible(object) &&
      (bounds.containsPoint(origin) || (ray.intersectBox(bounds, hit) && hit.distanceTo(origin) < distance - .015)));
    relevant.sort((a, b) => a.bounds.distanceToPoint(origin) - b.bounds.distanceToPoint(origin));
    const reverse = direction.clone().negate();
    raycaster.near = .015; raycaster.far = distance - .015;
    for (const { object } of relevant) {
      raycaster.set(origin, direction);
      if (raycaster.intersectObject(object, false).length) return true;
      // Reverse casting also treats one-sided wall faces as blockers without changing materials.
      raycaster.set(anchor, reverse);
      if (raycaster.intersectObject(object, false).length) return true;
    }
    return false;
  };
}

export function createBoardLabels({ THREE, camera, stage, boards, occluderRoots, onSelect,
  releaseInput = () => {}, isInputBusy = () => false, excludedElements = [], document = stage.ownerDocument }) {
  const layer = document.createElement('div');
  layer.className = 'electrical-board-labels';
  layer.setAttribute('aria-label', 'Nearby proposed switchboards');
  stage.append(layer);
  const listeners = new AbortController(), elements = new Map();
  let enabled = true, disposed = false, selected = null, lastTime = -Infinity, lastRoom = null, roomFilter = 'all';
  let lastView = '';
  let last = { visible: [], hidden: [] };
  let occluded = createBoardOcclusion(THREE, occluderRoots);
  for (const board of boards) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'electrical-board-label';
    const text = document.createElement('span');
    text.className = 'electrical-board-label-text';
    text.textContent = board.text;
    button.append(text);
    button.title = board.text;
    button.setAttribute('aria-label', `${board.text}: proposed switchboard details`);
    button.dataset.boardId = board.id;
    button.hidden = true;
    button.addEventListener('click', event => {
      if (isInputBusy()) { event.preventDefault(); return; }
      releaseInput(); onSelect(board.id);
    }, { signal: listeners.signal });
    layer.append(button); elements.set(board.id, button);
  }
  function hideAll(reason) {
    for (const button of elements.values()) button.hidden = true;
    last = { visible: [], hidden: boards.map(board => ({ id: board.id, reason })) };
  }
  return {
    setEnabled(value) { enabled = Boolean(value); lastTime = -Infinity; lastView = ''; if (!enabled) hideAll('disabled'); },
    select(id) { selected = id; lastTime = -Infinity; lastView = ''; },
    setRoomFilter(value) { roomFilter = value; lastTime = -Infinity; lastView = ''; },
    pick(clientX, clientY) {
      if (disposed || !enabled || isInputBusy()) return null;
      const rect = stage.getBoundingClientRect();
      const x = clientX - rect.x, y = clientY - rect.y;
      return last.visible.find(item => x >= item.box.x && x <= item.box.x + item.box.width &&
        y >= item.box.y && y <= item.box.y + item.box.height)?.id || null;
    },
    refreshOccluders(roots) { occluded = createBoardOcclusion(THREE, roots); lastTime = -Infinity; lastView = ''; },
    update({ time, room, paused = false }) {
      if (disposed) return;
      const busy = isInputBusy();
      layer.dataset.inputBusy = String(busy);
      if (!enabled || paused) { hideAll(!enabled ? 'disabled' : 'panel'); lastView = ''; return; }
      if (time - lastTime < 150 && room === lastRoom) return;
      const rect = stage.getBoundingClientRect();
      const excludedRects = excludedElements.filter(element => element && element.getClientRects().length)
        .map(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x - rect.x, y: box.y - rect.y, width: box.width, height: box.height };
        });
      camera.updateMatrixWorld();
      const view = [room, rect.width, rect.height, ...camera.matrixWorld.elements,
        ...camera.projectionMatrix.elements, ...excludedRects.flatMap(box => [box.x, box.y, box.width, box.height])].join('|');
      if (view === lastView) return;
      lastView = view; lastTime = time; lastRoom = room;
      const labelWidth = Math.min(164, Math.max(120, rect.width * .38));
      layer.style.setProperty('--board-label-width', `${labelWidth}px`);
      const activeBoards = boards.filter(board => roomFilter === 'all' || board.room === roomFilter || board.servedRooms?.includes(roomFilter));
      last = projectBoardLabels({ THREE, boards: activeBoards, camera, width: rect.width, height: rect.height,
        room, selected, occluded, excludedRects, labelWidth });
      last.hidden.push(...boards.filter(board => !activeBoards.includes(board)).map(board => ({ id: board.id, reason: 'filter' })));
      const positions = new Map(last.visible.map(item => [item.id, item]));
      for (const [id, button] of elements) {
        const position = positions.get(id);
        button.hidden = !position;
        button.setAttribute('aria-pressed', String(id === selected));
        if (position) button.style.transform = `translate(${position.box.x}px, ${position.box.y}px)`;
      }
    },
    snapshot: () => ({ enabled, visible: last.visible.map(item => item.id),
      hidden: last.hidden.map(item => ({ ...item })), selected, disposed }),
    dispose() {
      if (disposed) return;
      disposed = true; listeners.abort(); layer.remove(); elements.clear();
      last = { visible: [], hidden: [] };
    },
  };
}
