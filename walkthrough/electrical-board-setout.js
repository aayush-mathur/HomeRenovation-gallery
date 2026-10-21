const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

export function deriveSetout(board, [left, bottom, right, top]) {
  const [x, height, z] = board.position_web_m, [nx, ny, nz] = board.normal_web;
  if (Math.abs(ny) > .001 || Math.max(Math.abs(nx), Math.abs(nz)) < .999) throw new Error('Non-axis-aligned modeled wall');
  const alongY = Math.abs(nx) > Math.abs(nz);
  const wall = alongY ? (Math.abs(x - left) <= Math.abs(x - right) ? 'plan-left' : 'plan-right') :
    (Math.abs(-z - bottom) <= Math.abs(-z - top) ? 'plan-bottom' : 'plan-top');
  const [coordinate, low, high, lowEdge, highEdge] = alongY ?
    [-z, bottom, top, 'plan-bottom', 'plan-top'] : [x, left, right, 'plan-left', 'plan-right'];
  if (coordinate < low || coordinate > high || Math.abs(height * 1000 - 14 - board.height_aff_mm) > 1) {
    throw new Error('Board outside modeled extent or AFF datum');
  }
  const fromLow = coordinate - low <= high - coordinate;
  return { id: board.id, room: board.room, position_web_m: [...board.position_web_m], height_aff_mm: board.height_aff_mm,
    wall_side: wall, from_edge: fromLow ? lowEdge : highEdge,
    offset_mm: Math.round(Math.abs(coordinate - (fromLow ? low : high)) * 1000) };
}

export function validateBoardSetout(value, descriptor, manifestHash) {
  const fail = reason => { throw new Error(`Provisional set-out unavailable: ${reason}`); };
  if (!exact(value, ['version', 'id', 'board_manifest_sha256', 'room_source_sha256', 'rooms', 'boards']) ||
      value.version !== 1 || value.id !== 'board-setout-discussion') fail('schema');
  if (![value.board_manifest_sha256, value.room_source_sha256].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) ||
      value.board_manifest_sha256 !== manifestHash) fail('stale source binding');
  if (!Array.isArray(value.rooms) || value.rooms.length < 1 || value.rooms.length > 14) fail('rooms');
  const rooms = new Map();
  for (const room of value.rooms) {
    if (!exact(room, ['id', 'sheet_extent']) || typeof room.id !== 'string' || rooms.has(room.id) ||
        !Array.isArray(room.sheet_extent) || room.sheet_extent.length !== 4 ||
        !room.sheet_extent.every(n => Number.isFinite(n) && Math.abs(n) <= 100) ||
        room.sheet_extent[0] >= room.sheet_extent[2] || room.sheet_extent[1] >= room.sheet_extent[3]) fail('room extent');
    rooms.set(room.id, room.sheet_extent);
  }
  const sources = new Map(descriptor.boards.map(board => [board.id, board]));
  const usedRooms = new Set(descriptor.boards.map(board => board.room));
  if (!sources.size || sources.size !== descriptor.boards.length || rooms.size !== usedRooms.size ||
      [...usedRooms].some(id => !rooms.has(id))) fail('source boards/rooms');
  if (!Array.isArray(value.boards) || value.boards.length !== sources.size) fail('board count');
  const records = new Map();
  for (const record of value.boards) {
    if (!exact(record, ['id', 'room', 'position_web_m', 'height_aff_mm', 'wall_side', 'from_edge', 'offset_mm']) ||
        !sources.has(record.id) || records.has(record.id)) fail('board identity');
    const expected = deriveSetout(sources.get(record.id), rooms.get(sources.get(record.id).room));
    if (!Array.isArray(record.position_web_m) || record.position_web_m.length !== 3 ||
        !record.position_web_m.every((n, i) => Number.isFinite(n) && n === expected.position_web_m[i]) ||
        !Number.isSafeInteger(record.height_aff_mm) || !Number.isSafeInteger(record.offset_mm) ||
        ['room', 'height_aff_mm', 'wall_side', 'from_edge', 'offset_mm'].some(key => record[key] !== expected[key])) {
      fail('board position/room/AFF/derived offset');
    }
    records.set(record.id, Object.freeze({ ...expected, position_web_m: Object.freeze(expected.position_web_m) }));
  }
  return records;
}

export function setoutLabel(record) {
  return `${record.offset_mm} mm from ${record.from_edge} edge\nProposed ${record.height_aff_mm} mm AFF`;
}
