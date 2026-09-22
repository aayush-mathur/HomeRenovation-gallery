// 35 mm-equivalent rectilinear lens: a fixed 36 mm horizontal film gate.
export function lensProjection(aspect, focalLength = null) {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError('Invalid viewport aspect');
  const auto = focalLength === null;
  if (!auto && (!Number.isFinite(focalLength) || focalLength < 16 || focalLength > 70)) {
    throw new RangeError('Lens must be between 16 and 70 mm');
  }
  const fov = auto
    ? Math.min(62, 2 * Math.atan(1 / aspect) * 180 / Math.PI)
    : 2 * Math.atan(36 / (2 * focalLength * aspect)) * 180 / Math.PI;
  return { fov, focalLength: auto ? 18 / (aspect * Math.tan(fov * Math.PI / 360)) : focalLength, auto };
}

export function applyLens(camera, focalLength = null) {
  const lens = lensProjection(camera.aspect, focalLength);
  camera.fov = lens.fov;
  camera.updateProjectionMatrix();
  return lens;
}

export function isSafe(nav, x, y) {
  const col = Math.floor((x - nav.origin[0]) / nav.step);
  const row = Math.floor((y - nav.origin[1]) / nav.step);
  return col >= 0 && row >= 0 && col < nav.width && row < nav.height
    && nav.cells[row * nav.width + col] === '1';
}

export function move(nav, position, dx, dy, dynamicSafe = () => true) {
  const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (nav.step * .35)));
  let [x, y] = position;
  for (let i = 0; i < count; i++) {
    const nx = x + dx / count, ny = y + dy / count;
    // Axis checks prevent cutting between diagonally touching blocked cells.
    if (isSafe(nav, nx, y) && dynamicSafe(nx, y)) x = nx;
    if (isSafe(nav, x, ny) && dynamicSafe(x, ny)) y = ny;
  }
  return [x, y];
}

export function movementVector(forward, sideways, yaw, dt, speed = 1.35) {
  const length = Math.hypot(forward, sideways);
  if (!length) return [0, 0];
  const scale = speed * Math.min(Math.max(dt, 0), .05) / Math.max(1, length);
  return [(sideways * Math.cos(yaw) - forward * Math.sin(yaw)) * scale,
    (forward * Math.cos(yaw) + sideways * Math.sin(yaw)) * scale];
}

export function roomAt(nav, position) {
  const [x, y] = position;
  return (nav.rooms || nav.presets).find(room => {
    let inside = false;
    const polygon = room.room_polygon;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}
