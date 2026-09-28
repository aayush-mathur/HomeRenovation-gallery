import * as THREE from 'three';
import { RectAreaLightUniformsLib } from './vendor/RectAreaLightUniformsLib.js';

export const FIXTURE_BUDGET = 8;
export const CURVED_COVE_RADIANCE = 4;
const MAX_ROOM_VERTICES = 8;
export function isDiffuser(material) {
  return Boolean(material?.emissive && /(?:\bled\b|diffuser)/i.test(material.name));
}

// The export batches disconnected fixtures by material and duplicates vertices
// at face seams. Weld positions for discovery only; never modify source geometry.
export function fixtureComponents(mesh) {
  const geometry = mesh.geometry, positions = geometry.attributes.position;
  const index = geometry.index, ids = [], points = [], parents = [], welded = new Map();
  const find = i => parents[i] === i ? i : (parents[i] = find(parents[i]));
  for (let i = 0; i < positions.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
    const key = p.toArray().map(v => Math.round(v * 1e5)).join(',');
    if (!welded.has(key)) {
      welded.set(key, points.length); parents.push(points.length); points.push(p);
    }
    ids.push(welded.get(key));
  }
  const triangles = [];
  for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
    const tri = [0, 1, 2].map(j => ids[index ? index.getX(i + j) : i + j]);
    for (const v of tri) parents[find(v)] = find(tri[0]);
    triangles.push(tri);
  }
  const components = new Map();
  for (const tri of triangles) {
    const key = find(tri[0]);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(tri.map(i => points[i]));
  }
  return [...components.values()];
}

export function rectangleForTriangles(triangles) {
  let largest = 0, normal = new THREE.Vector3();
  const points = [...new Set(triangles.flat())];
  for (const [a, b, c] of triangles) {
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    const size = cross.length();
    if (size > largest) { largest = size; normal.copy(cross).normalize(); }
  }
  if (!largest) return null;
  // Evaluate edge-aligned frames, not the world AABB: a rotated narrow strip
  // must not become a large square light covering the room.
  let best;
  const directions = new Set();
  for (const tri of triangles) for (let i = 0; i < 3; i++) {
    const u = tri[(i + 1) % 3].clone().sub(tri[i]);
    u.addScaledVector(normal, -u.dot(normal));
    if (u.lengthSq() < 1e-12) continue;
    u.normalize();
    const direction = u.toArray().map(n => Math.round(n * 1e5));
    if (direction.find(n => n !== 0) < 0) direction.forEach((n, j) => { direction[j] = -n; });
    const key = direction.join(',');
    if (directions.has(key)) continue;
    directions.add(key);
    const v = normal.clone().cross(u).normalize();
    const axes = [u, v, normal];
    const low = axes.map(axis => Math.min(...points.map(p => p.dot(axis))));
    const high = axes.map(axis => Math.max(...points.map(p => p.dot(axis))));
    const sizes = high.map((value, j) => value - low[j]);
    if (!best || sizes[0] * sizes[1] < best.width * best.height - 1e-10) {
      best = { u, v, normal: normal.clone(), width: sizes[0], height: sizes[1], thickness: sizes[2],
        center: axes.reduce((p, axis, j) => p.addScaledVector(axis, (low[j] + high[j]) / 2), new THREE.Vector3()) };
    }
  }
  if (!best || Math.min(best.width, best.height) < .001) return null;
  if (best.width < best.height) {
    [best.width, best.height] = [best.height, best.width];
    [best.u, best.v] = [best.v.clone(), best.u.clone().negate()];
  }
  // Covers are thin closed solids; choose the exposed downward face. The
  // concealed 7–15 mm ceiling ribbons are uplights in all authored schemes.
  const cove = best.height <= .018 && best.width > .25 && best.center.y > 2.5;
  if ((cove ? 1 : -1) * best.normal.y < 0) {
    best.normal.negate(); best.v.negate();
  }
  best.center.addScaledVector(best.normal, best.thickness / 2 + .001);
  const projectedArea = triangles.reduce((sum, [a, b, c]) =>
    sum + Math.abs(b.clone().sub(a).cross(c.clone().sub(a)).dot(normal)) / 2, 0);
  best.area = Math.min(best.width * best.height, projectedArea / (best.thickness < 1e-5 ? 1 : 2));
  best.kind = cove ? 'cove' : best.width / best.height > 4 ? 'linear' : 'area';
  return best;
}

export function distanceToFixture(fixture, point) {
  if (fixture.patches) return Math.min(...fixture.patches.map(p => distanceToFixture(p, point)));
  const offset = point.clone().sub(fixture.center);
  return Math.hypot(
    Math.max(0, Math.abs(offset.dot(fixture.u)) - fixture.width / 2),
    Math.max(0, Math.abs(offset.dot(fixture.v)) - fixture.height / 2),
    offset.dot(fixture.normal));
}

// Only the authored v002 material opts into curved-source quadrature. A closed
// ribbon is one fixture, not a giant luminous rectangle spanning its empty eye.
export function curvedFixture(triangles) {
  const upward = triangles.filter(([a,b,c]) =>
    b.clone().sub(a).cross(c.clone().sub(a)).normalize().y > .99);
  if (!upward.length) throw new Error('Curved cove has no upward emitting surface');
  const center = new THREE.Box3().setFromPoints(upward.flat()).getCenter(new THREE.Vector3());
  const sectors = Array.from({ length: 24 }, () => []);
  for (const tri of upward) {
    const p = tri.reduce((sum,v) => sum.add(v), new THREE.Vector3()).multiplyScalar(1/3);
    const angle = (Math.atan2(p.z-center.z,p.x-center.x)+Math.PI*2) % (Math.PI*2);
    sectors[Math.min(23,Math.floor(angle/(Math.PI/12)))].push(tri);
  }
  const patches = sectors.filter(part => part.length).map(part => {
    const patch = rectangleForTriangles(part);
    if (!patch) throw new Error('Invalid curved cove source patch');
    if (patch.normal.y < 0) { patch.normal.negate(); patch.v.negate(); }
    patch.kind = 'curved-cove';
    return patch;
  });
  if (patches.length < 12) throw new Error('Curved cove must cover its complete perimeter');
  return { ...patches[0], center, patches, radiance: CURVED_COVE_RADIANCE,
    area: patches.reduce((sum,p) => sum+p.area,0) };
}

export function distributeFixtureSources(fixtures, budget) {
  const selected = [];
  let remaining = budget;
  for (const fixture of fixtures) {
    const slots = fixture.patches ? 2 : 1;
    if (slots > remaining) continue;
    selected.push({ fixture, slots }); remaining -= slots;
  }
  for (let i = 0; remaining && selected.some(s => s.fixture.patches && s.slots < 8); i++) {
    const item = selected[i % selected.length];
    if (item.fixture.patches && item.slots < 8) { item.slots++; remaining--; }
  }
  return selected.flatMap(({ fixture, slots }, source) => {
    if (!fixture.patches) return [fixture];
    // Equal-angle samples surround the complete source, rather than clustering
    // nearest the camera. Area weights conserve its total authored radiance.
    const samples = Array.from({ length: slots }, (_,i) =>
      fixture.patches[Math.floor((i+.5)*fixture.patches.length/slots)]);
    const sampledArea = samples.reduce((sum,p) => sum+p.area,0);
    return samples.map(p => ({ ...fixture, ...p, patches: undefined,
      radianceWeight: fixture.area/sampledArea, source, sourceArea: fixture.area }));
  });
}

export function containsPoint(polygon, x, z) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > -z) !== (by > -z) && x < (bx - ax) * (-z - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function selectFixtures(fixtures, point, budget = FIXTURE_BUDGET) {
  return fixtures.filter(f => (!f.root || f.root.parent) && f.mesh.visible && f.mesh.parent &&
    (() => { for (let p = f.mesh.parent; p; p = p.parent) if (!p.visible) return false; return true; })())
    .filter(f => distanceToFixture(f, point) < 6)
    .sort((a, b) => distanceToFixture(a, point) - distanceToFixture(b, point))
    .slice(0, budget);
}

export function createFixtureLighting(scene, { budget = FIXTURE_BUDGET } = {}) {
  RectAreaLightUniformsLib.init();
  const lights = Array.from({ length: budget }, () => {
    const light = new THREE.RectAreaLight(0xffffff, 0, .01, .01);
    scene.add(light); return light;
  });
  const roomVertices = Array.from({ length: MAX_ROOM_VERTICES }, () => new THREE.Vector2());
  const roomCount = { value: 0 };
  const fixtures = [], roots = new WeakSet(), patched = new WeakSet(), diffusers = new WeakSet();
  let active = [], rooms = [];
  const patch = material => {
    if (!material?.isMeshStandardMaterial || patched.has(material)) return;
    patched.add(material);
    material.onBeforeCompile = shader => {
      shader.uniforms.fixtureRoomVertices = { value: roomVertices };
      shader.uniforms.fixtureRoomCount = roomCount;
      shader.vertexShader = 'varying vec3 fixtureWorldPosition;\n' + shader.vertexShader.replace(
        '#include <project_vertex>', '#include <project_vertex>\nfixtureWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = `
varying vec3 fixtureWorldPosition;
uniform vec2 fixtureRoomVertices[${MAX_ROOM_VERTICES}];
uniform int fixtureRoomCount;
float fixtureRoomMask() {
  int count = fixtureRoomCount;
  if (count == 0) return 0.0;
  bool inside = false;
  vec2 p = vec2(fixtureWorldPosition.x, -fixtureWorldPosition.z);
  vec2 b = fixtureRoomVertices[count - 1];
  for (int j = 0; j < ${MAX_ROOM_VERTICES}; j++) {
    if (j >= count) break;
    vec2 a = fixtureRoomVertices[j];
    vec2 edge = b - a;
    float t = clamp(dot(p-a, edge) / max(dot(edge, edge), 0.000001), 0.0, 1.0);
    if (length(p - (a + edge * t)) < 0.035) return 1.0;
    if ((a.y > p.y) != (b.y > p.y)) {
      if (p.x < (b.x-a.x) * (p.y-a.y) / (b.y-a.y) + a.x) inside = !inside;
    }
    b = a;
  }
  return inside ? 1.0 : 0.0;
}
` + shader.fragmentShader.replace('#include <lights_fragment_begin>',
        'float activeFixtureMask = fixtureRoomMask();\n' +
        THREE.ShaderChunk.lights_fragment_begin.replace(
          /(RE_Direct_RectArea\( rectAreaLight,[^\n]+;)/,
          'if (activeFixtureMask > 0.0 && dot(rectAreaLight.color, vec3(1.0)) > 0.0) { $1 }'));
    };
    material.customProgramCacheKey = () => `fixture-room-v2-${budget}`;
    material.needsUpdate = true;
  };
  return {
    setRooms(value) {
      rooms = (value || []).filter(r => r.room_polygon?.length >= 3 &&
        r.room_polygon.length <= MAX_ROOM_VERTICES &&
        r.room_polygon.every(p => p.length === 2 && p.every(Number.isFinite)));
    },
    register(root) {
      if (roots.has(root)) return;
      roots.add(root); root.updateWorldMatrix(true, true);
      root.traverse(mesh => {
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        materials.forEach(patch);
        // Current exports are single-material batches. Do not guess which faces
        // emit in a future multi-material primitive.
        if (materials.length !== 1 || !isDiffuser(materials[0])) return;
        const mat = materials[0];
        if (!diffusers.has(mat)) {
          diffusers.add(mat);
          mat.emissive.copy(mat.color);
          mat.emissiveIntensity = /LX2 curved cove LED/.test(mat.name) ? .65 : 3;
          mat.color.setRGB(0, 0, 0);
          mat.metalness = 0; mat.roughness = 1;
        }
        for (const triangles of fixtureComponents(mesh)) {
          const fixture = /LX2 curved cove LED/.test(mat.name)
            ? curvedFixture(triangles) : rectangleForTriangles(triangles);
          if (!fixture || fixture.area < .0003) continue;
          fixture.mesh = mesh;
          fixture.root = root;
          fixture.color = mat.emissive.clone();
          fixture.room = rooms.find(r => containsPoint(r.room_polygon, fixture.center.x, fixture.center.z));
          if (fixture.room) fixtures.push(fixture);
        }
      });
    },
    update(point) {
      // Remove disposed overlays. Visibility is checked before ranking whole
      // sources, so switching schemes never leaves hidden lights in the budget.
      for (let i = fixtures.length - 1; i >= 0; i--) if (!fixtures[i].root.parent) fixtures.splice(i, 1);
      const room = rooms.find(r => containsPoint(r.room_polygon, point.x, point.z));
      active = distributeFixtureSources(selectFixtures(fixtures.filter(f => f.room === room), point, budget), budget);
      roomCount.value = room?.room_polygon.length || 0;
      room?.room_polygon.forEach((p, j) => roomVertices[j].set(...p));
      for (let i = 0; i < budget; i++) {
        const light = lights[i], f = active[i];
        light.intensity = 0;
        if (!f) continue;
        light.position.copy(f.center);
        light.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.u, f.v, f.normal));
        // RectAreaLight emits along -Z, whereas f.normal points out of diffuser.
        light.rotateY(Math.PI);
        light.width = f.width; light.height = f.height; light.color.copy(f.color);
        light.intensity = (f.radiance ?? 28) * f.area * (f.radianceWeight || 1) / (f.width * f.height);
      }
    },
    snapshot: () => ({ budget, total: fixtures.length, active: active.map(f => ({
      kind: f.kind, room: f.room.id, center: f.center.toArray(), width: f.width, height: f.height,
      normal: f.normal.toArray(), area: f.area, power: (f.radiance ?? 28) * f.area * (f.radianceWeight || 1) * Math.PI,
      ...(f.sourceArea ? { source: f.source, sourceArea: f.sourceArea } : {}),
    })) }),
    dispose() { for (const light of lights) scene.remove(light); fixtures.length = 0; },
  };
}
