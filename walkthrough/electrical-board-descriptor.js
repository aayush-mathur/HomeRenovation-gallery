const HASH = /^[a-f0-9]{64}$/;
const FLOOR_ELEVATION_MM = 14; // v003 source-bound house finish floor, not an assumed zero datum.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ROOMS = new Set(['bedroom_1', 'bedroom_2', 'bedroom_3', 'drawing', 'lounge', 'dining',
  'kitchen', 'lobby', 'bathroom_1', 'bathroom_2', 'bathroom_3', 'dressing_3', 'utility', 'rear_ots']);
const KINDS = new Set(['switch', 'fan-control', 'socket', 'usb-c', 'data', 'isolation-control']);
const BACKUP = new Set(['requested', 'mains-only', 'not-decided']);
const SOURCE_TYPES = new Set(['india-framework', 'manufacturer-guidance', 'international-reference', 'project-assumption']);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const text = (value, max = 240) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max, min = 0) => Array.isArray(value) && value.length >= min && value.length <= max;
const vector = value => list(value, 3, 3) && value.every(n => Number.isFinite(n) && Math.abs(n) <= 100);
const uniqueRefs = (values, allowed, min = 0) => list(values, 100, min) &&
  new Set(values).size === values.length && values.every(id => allowed.has(id));

export function boardRooms(board, fixtureGroups) {
  const groupIDs = new Set(board.functions.flatMap(control => control.fixture_group_ids));
  return [...new Set([board.room, ...fixtureGroups.filter(group => groupIDs.has(group.id) && group.room !== 'shared')
    .map(group => group.room)])];
}

export function validateBoardDescriptor(value, house, baseURL) {
  const fail = reason => { throw new Error(`Switchboard planning unavailable: ${reason}`); };
  const top = ['version', 'id', 'base_source_sha256', 'base_navigation_sha256', 'luxe_sha256',
    'model', 'boards', 'requirements', 'fixture_groups', 'reasons', 'sources'];
  if (!exact(value, top) || value.version !== 2 || value.id !== 'electrical-v003') fail('unsupported public descriptor');
  const luxe = house.ceiling_options?.variants.find(variant => variant.id === 'luxe');
  if (![value.base_source_sha256, value.base_navigation_sha256, value.luxe_sha256].every(hash => HASH.test(hash)) ||
      value.base_source_sha256 !== house.source_sha256 || value.base_navigation_sha256 !== house.navigation_sha256 ||
      value.luxe_sha256 !== luxe?.sha256) fail('boards do not match this house, navigation and Luxe revision');
  const model = value.model;
  if (!exact(model, ['src', 'sha256', 'bytes']) || !HASH.test(model.sha256) ||
      !Number.isSafeInteger(model.bytes) || model.bytes < 20 || model.bytes > 10_000_000 ||
      model.src !== `./model/electrical/boards-${model.sha256.slice(0, 16)}.glb`) fail('invalid or unsafe board asset');
  const base = new URL(baseURL), url = new URL(model.src, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(new URL('./model/electrical/', base).pathname)) fail('asset escapes viewer scope');
  if (!list(value.boards, 150, 1) || !list(value.requirements, 150) || !list(value.fixture_groups, 200) ||
      !list(value.reasons, 300, 1) || !list(value.sources, 80, 1)) fail('incomplete or oversized catalog');
  const identitySet = (items, label) => {
    const ids = new Set();
    for (const item of items) {
      if (!item || !ID.test(item.id) || ids.has(item.id)) fail(`invalid or duplicate ${label} ID`);
      ids.add(item.id);
    }
    return ids;
  };
  const sourceIDs = identitySet(value.sources, 'source');
  const reasonIDs = identitySet(value.reasons, 'reason');
  const fixtureIDs = identitySet(value.fixture_groups, 'fixture group');
  identitySet([...value.boards, ...value.requirements], 'board/requirement');
  for (const source of value.sources) {
    if (!exact(source, ['id', 'title', 'url', 'classification']) || !text(source.title, 200) ||
        !SOURCE_TYPES.has(source.classification)) fail('invalid source metadata');
    if (source.classification === 'project-assumption') {
      if (source.url !== '') fail('project assumptions must not imply external authority');
    } else {
      if (!text(source.url, 1200)) fail('missing source link');
      let target;
      try { target = new URL(source.url); } catch { fail('invalid source link'); }
      if (target.protocol !== 'https:' || target.username || target.password) fail('unsafe source link');
    }
  }
  for (const reason of value.reasons) {
    if (!exact(reason, ['id', 'summary', 'source_ids', 'constraints']) || !text(reason.summary, 1200) ||
        !uniqueRefs(reason.source_ids, sourceIDs, 1) || !list(reason.constraints, 20) ||
        !reason.constraints.every(item => text(item, 500))) fail('invalid or unbound design reason');
  }
  for (const fixture of value.fixture_groups) {
    if (!exact(fixture, ['id', 'label', 'room', 'status']) || !text(fixture.label, 160) ||
        !(ROOMS.has(fixture.room) || (fixture.room === 'shared' && fixture.status === 'unselected-product')) ||
        !['existing-luxe', 'existing-house', 'unselected-product'].includes(fixture.status)) {
      fail('invalid public fixture group');
    }
  }
  const functionIDs = new Set();
  for (const board of value.boards) {
    if (!exact(board, ['id', 'label', 'room', 'node_name', 'position_web_m', 'normal_web', 'height_aff_mm',
      'size_mm', 'functions', 'reason_ids']) || !text(board.label, 80) || !ROOMS.has(board.room) ||
        board.node_name !== `BOARD_${board.id}` || !vector(board.position_web_m) || !vector(board.normal_web) ||
        Math.abs(Math.hypot(...board.normal_web) - 1) > .001 ||
        !Number.isInteger(board.height_aff_mm) || board.height_aff_mm < 100 || board.height_aff_mm > 2500 ||
        Math.abs(board.position_web_m[1] * 1000 - board.height_aff_mm - FLOOR_ELEVATION_MM) > 1 ||
        !list(board.size_mm, 3, 3) || !board.size_mm.every(n => Number.isFinite(n) && n > 0) ||
        board.size_mm[0] > 1500 || board.size_mm[1] > 800 || board.size_mm[2] > 100 ||
        !list(board.functions, 40, 1) || !uniqueRefs(board.reason_ids, reasonIDs, 1)) {
      fail('invalid physical board or face anchor');
    }
    const slots = new Set();
    for (const control of board.functions) {
      if (!exact(control, ['id', 'label', 'kind', 'slot', 'span', 'point_ids', 'fixture_group_ids', 'backup_preference', 'behavior']) ||
          !ID.test(control.id) || functionIDs.has(control.id) || !text(control.label, 160) || !KINDS.has(control.kind) ||
          !Number.isInteger(control.slot) || control.slot < 0 || !Number.isInteger(control.span) || control.span < 1 ||
          control.slot + control.span > 40 || !list(control.point_ids, 100, 1) ||
          new Set(control.point_ids).size !== control.point_ids.length ||
          !control.point_ids.every(id => /^E-[A-Z0-9]{2,3}-\d{2}$/.test(id)) ||
          !uniqueRefs(control.fixture_group_ids, fixtureIDs) || !BACKUP.has(control.backup_preference) ||
          !text(control.behavior, 700)) fail('invalid control/module mapping');
      functionIDs.add(control.id);
      for (let slot = control.slot; slot < control.slot + control.span; slot++) {
        if (slots.has(slot)) fail('overlapping board modules');
        slots.add(slot);
      }
    }
  }
  for (const requirement of value.requirements) {
    if (!exact(requirement, ['id', 'label', 'room', 'point_ids', 'state', 'reason_ids']) ||
        !text(requirement.label, 200) || !ROOMS.has(requirement.room) ||
        !['installer-placement-required', 'not-in-current-layout'].includes(requirement.state) ||
        !list(requirement.point_ids, 100, 1) || new Set(requirement.point_ids).size !== requirement.point_ids.length ||
        !requirement.point_ids.every(id => /^E-[A-Z0-9]{2,3}-\d{2}$/.test(id)) ||
        !uniqueRefs(requirement.reason_ids, reasonIDs, 1)) fail('invalid unplaced/reference requirement');
  }
  return { ...structuredClone(value), model: { ...model, url: url.href } };
}
