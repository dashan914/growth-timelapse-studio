import * as THREE from 'three';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const DEFAULT_PROFILE = Object.freeze({maxHeight:.60, maxWidth:.64, plateFill:.90, screenMargin:.035, bottomLimit:.90, centerZ:0});

// Read current world transforms without updating caller-owned matrices. Camera
// parents may have changed since the last render/ResizeObserver callback.
function worldMatrix(object) {
  const local = object.matrixAutoUpdate
    ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale)
    : object.matrix.clone();
  return object.parent ? worldMatrix(object.parent).multiply(local) : local;
}
function groundXZ(point) {
  if (!point) return null;
  const x = Array.isArray(point) || ArrayBuffer.isView(point) ? point[0] : point.x;
  const z = Array.isArray(point) || ArrayBuffer.isView(point) ? point[point.length >= 3 ? 2 : 1] : point.z;
  return finite(x) && finite(z) ? {x,z} : null;
}

/** Locate a photographed plate-pattern centre on the calibrated Y=0 plane.
 * patternCenter is normalized against the camera's complete source frame. Its
 * ray, rather than a guessed world XZ offset, preserves each photo's placement.
 * Older profiles without a pattern keep their physical plate-origin anchor.
 */
export function printerPatternGroundPoint(camera, profile = {}) {
  if (!camera?.isPerspectiveCamera || !profile || typeof profile !== 'object') return null;
  const pattern = profile.patternCenter;
  if (pattern === undefined || pattern === null) return new THREE.Vector3();
  if (![pattern.x,pattern.y].every(finite) || pattern.x < 0 || pattern.x > 1 || pattern.y < 0 || pattern.y > 1) return null;
  const cameraWorld = worldMatrix(camera), projection = camera.projectionMatrix;
  if (![...cameraWorld.elements,...projection.elements].every(finite)
    || Math.abs(cameraWorld.determinant()) < 1e-14 || Math.abs(projection.determinant()) < 1e-14) return null;
  const origin = new THREE.Vector3().setFromMatrixPosition(cameraWorld);
  const direction = new THREE.Vector3(pattern.x * 2 - 1,1 - pattern.y * 2,.5)
    .applyMatrix4(projection.clone().invert()).applyMatrix4(cameraWorld).sub(origin);
  if (![direction.x,direction.y,direction.z].every(finite) || Math.abs(direction.y) <= 1e-12) return null;
  const distance = -origin.y / direction.y;
  if (!finite(distance) || distance <= 0) return null;
  const point = origin.addScaledVector(direction,distance);
  if (![point.x,point.z].every(finite)) return null;
  point.y = 0;
  return point;
}

/** Apply a source orientation relative to the camera at its ground anchor.
 * A 90-degree relative yaw faces a -X source front toward the camera. Profiles
 * with a measured source front supply its actual angle instead. Source mesh
 * and build orientation remain unchanged.
 */
export function printerModelYaw(camera, relativeYawDeg = 90, targetPoint = null) {
  if (!camera?.isPerspectiveCamera || !finite(relativeYawDeg)) return null;
  const target = targetPoint === null ? {x:0,z:0} : groundXZ(targetPoint);
  if (!target) return null;
  const matrix = worldMatrix(camera);
  if (!matrix.elements.every(finite)) return null;
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  const x = position.x - target.x, z = position.z - target.z;
  if (Math.hypot(x,z) <= 1e-12) return null;
  return THREE.MathUtils.radToDeg(Math.atan2(x,z)) + relativeYawDeg;
}

/** Fit the full original model to its plate and photograph. points is optional
 * packed xyz data already rotated by the chosen yaw, just like bounds. Using
 * actual vertices avoids the empty corners above asymmetric tails shrinking
 * the visible model. contactCenter anchors its lower contact area in XZ;
 * bounds.min.y keeps the complete soles on the calibrated plane. Optional
 * footprintBounds describes the near-ground contact region: raised tails can
 * overhang the sheet while the feet remain inside it. Full bounds are the
 * conservative fallback. Source dimensions and caller inputs never change.
 */
export function fitPrinterModelPose({bounds, camera, bedSize, profile = {}, points = null, contactCenter = null, footprintBounds = null,
  offsetUnit = 4, minScale = .1, maxScale = 5} = {}) {
  if (!bounds?.isBox3 || !camera?.isPerspectiveCamera || !bedSize || !profile || typeof profile !== 'object') return null;
  const desired = {...DEFAULT_PROFILE,...profile};
  const values = [bounds.min.x,bounds.min.y,bounds.min.z,bounds.max.x,bounds.max.y,bounds.max.z,
    bedSize.width,bedSize.depth,desired.maxHeight,desired.maxWidth,desired.plateFill,
    desired.screenMargin,desired.bottomLimit,desired.centerZ,offsetUnit,minScale,maxScale];
  if (!values.every(finite) || bounds.isEmpty() || bedSize.width <= 0 || bedSize.depth <= 0
    || offsetUnit <= 0 || minScale <= 0 || maxScale < minScale
    || desired.maxHeight <= 0 || desired.maxHeight > 1 || desired.maxWidth <= 0 || desired.maxWidth > 1
    || desired.plateFill <= 0 || desired.plateFill > 1 || desired.screenMargin < 0 || desired.screenMargin >= .5
    || desired.bottomLimit <= desired.screenMargin || desired.bottomLimit > 1 - desired.screenMargin
    || Math.abs(desired.centerZ) >= desired.plateFill / 2) return null;
  const footprint = footprintBounds === null ? bounds : footprintBounds;
  if (!footprint?.isBox3 || footprint.isEmpty() || ![footprint.min.x,footprint.min.y,footprint.min.z,
    footprint.max.x,footprint.max.y,footprint.max.z].every(finite)) return null;
  const size = bounds.getSize(new THREE.Vector3());
  if (size.y <= 0 || Math.max(size.x,size.z) <= 0) return null;
  const projection = camera.projectionMatrix.clone(), cameraWorld = worldMatrix(camera);
  if (![...projection.elements,...cameraWorld.elements].every(finite)
    || Math.abs(projection.determinant()) < 1e-14 || Math.abs(cameraWorld.determinant()) < 1e-14
    || !finite(camera.near) || camera.near <= 0 || !(camera.far > camera.near)) return null;
  const target = printerPatternGroundPoint(camera,desired);
  if (!target) return null;
  if (desired.patternCenter === undefined || desired.patternCenter === null) target.z = desired.centerZ * bedSize.depth;
  const center = bounds.getCenter(new THREE.Vector3());
  const contact = contactCenter === null ? {x:center.x,z:center.z} : groundXZ(contactCenter);
  if (!contact) return null;
  const anchor = {x:contact.x,y:bounds.min.y,z:contact.z};
  let source = points;
  if (source === null) {
    source = new Float64Array(24); let index = 0;
    for (const x of [bounds.min.x,bounds.max.x]) for (const y of [bounds.min.y,bounds.max.y]) for (const z of [bounds.min.z,bounds.max.z]) {
      source[index++] = x; source[index++] = y; source[index++] = z;
    }
  } else if (!(source instanceof Float32Array || source instanceof Float64Array || Array.isArray(source))
    || source.length < 3 || source.length % 3) return null;
  const view = cameraWorld.clone().invert(), ve = view.elements, pe = projection.elements;
  const targetView = target.clone().applyMatrix4(view), transformed = new Float64Array(source.length);
  let minX = footprint.min.x,maxX = footprint.max.x,minZ = footprint.min.z,maxZ = footprint.max.z;
  for (let index = 0; index < source.length; index += 3) {
    const sx = source[index],sy = source[index+1],sz = source[index+2];
    if (!finite(sx) || !finite(sy) || !finite(sz)) return null;
    // Full-box fallback also includes any extrema omitted from approximate
    // bounds. An explicit contact footprint deliberately excludes raised parts;
    // all of them still participate in clipping and photographic framing.
    if (footprintBounds === null) {
      minX = Math.min(minX,sx); maxX = Math.max(maxX,sx); minZ = Math.min(minZ,sz); maxZ = Math.max(maxZ,sz);
    }
    const x = sx-anchor.x,y = sy-anchor.y,z = sz-anchor.z;
    transformed[index] = ve[0]*x + ve[4]*y + ve[8]*z;
    transformed[index+1] = ve[1]*x + ve[5]*y + ve[9]*z;
    transformed[index+2] = ve[2]*x + ve[6]*y + ve[10]*z;
  }
  const halfWidth = bedSize.width * desired.plateFill / 2, halfDepth = bedSize.depth * desired.plateFill / 2;
  const tolerance = 1e-10;
  const fits = scale => {
    // Each edge is tested separately. A tail extending behind the contact
    // centre must not consume the unused space in front of the model.
    if ((minX-anchor.x)*scale+target.x < -halfWidth-tolerance
      || (maxX-anchor.x)*scale+target.x > halfWidth+tolerance
      || (minZ-anchor.z)*scale+target.z < -halfDepth-tolerance
      || (maxZ-anchor.z)*scale+target.z > halfDepth+tolerance) return false;
    let left = Infinity,right = -Infinity,top = Infinity,bottom = -Infinity;
    for (let index = 0; index < transformed.length; index += 3) {
      const x = transformed[index]*scale+targetView.x,y = transformed[index+1]*scale+targetView.y,z = transformed[index+2]*scale+targetView.z;
      if (-z <= camera.near || -z >= camera.far) return false;
      const w = pe[3]*x+pe[7]*y+pe[11]*z+pe[15];
      if (!finite(w) || Math.abs(w) < 1e-14) return false;
      const u = ((pe[0]*x+pe[4]*y+pe[8]*z+pe[12])/w+1)/2;
      const v = (1-(pe[1]*x+pe[5]*y+pe[9]*z+pe[13])/w)/2;
      if (!finite(u) || !finite(v) || u < desired.screenMargin-tolerance || u > 1-desired.screenMargin+tolerance
        || v < desired.screenMargin-tolerance || v > desired.bottomLimit+tolerance) return false;
      left = Math.min(left,u); right = Math.max(right,u); top = Math.min(top,v); bottom = Math.max(bottom,v);
      if (right-left > desired.maxWidth+tolerance || bottom-top > desired.maxHeight+tolerance) return false;
    }
    return true;
  };
  if (!fits(minScale)) return null;
  let low = minScale,high = maxScale;
  if (fits(maxScale)) low = maxScale;
  else for (let iteration = 0; iteration < 40; iteration++) {
    const scale = (low+high)/2;
    if (fits(scale)) low = scale; else high = scale;
  }
  return {
    modelOffsetX:(target.x-anchor.x*low)/offsetUnit,
    modelOffsetY:-bounds.min.y*low/offsetUnit,
    modelOffsetZ:(target.z-anchor.z*low)/offsetUnit,
    modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:low,
  };
}
