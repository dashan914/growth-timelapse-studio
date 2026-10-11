import * as THREE from '../node_modules/three/build/three.module.js';

/** Rebuild shading normals without changing a single triangle or position.
 * Only connected faces sharing an original edge can smooth together. Hard
 * edges split indexed vertices; equal positions with distinct indexes are never
 * welded. Corner-angle weights avoid a large wall overpowering a small ledge.
 */
export function withCreaseNormals(geometry, creaseAngle = 50 * Math.PI / 180) {
  const position = geometry?.getAttribute('position');
  if (!geometry?.isBufferGeometry || !position || position.itemSize !== 3) throw new TypeError('硬边法线需要三维网格。');
  if (!Number.isFinite(creaseAngle) || creaseAngle < 0 || creaseAngle > Math.PI) throw new RangeError('硬边夹角必须介于 0 和 180 度之间。');
  const vertexCount = position.count;
  const original = geometry.index;
  const cornerCount = original?.count ?? vertexCount;
  if (cornerCount % 3) throw new RangeError('网格三角形索引数量无效。');
  const sourceIndex = new Uint32Array(cornerCount);
  for (let corner = 0; corner < cornerCount; corner++) {
    const id = original ? original.getX(corner) : corner;
    if (!Number.isInteger(id) || id < 0 || id >= vertexCount) throw new RangeError('三角形引用了无效顶点。');
    sourceIndex[corner] = id;
  }
  const heads = new Int32Array(vertexCount).fill(-1);
  const next = new Int32Array(cornerCount);
  const faceNormals = new Float64Array(cornerCount);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), faceNormal = new THREE.Vector3();
  for (let base = 0; base < cornerCount; base += 3) {
    a.fromBufferAttribute(position, sourceIndex[base]);
    b.fromBufferAttribute(position, sourceIndex[base + 1]);
    c.fromBufferAttribute(position, sourceIndex[base + 2]);
    ab.subVectors(b, a); ac.subVectors(c, a);
    faceNormal.crossVectors(ab, ac);
    const length = faceNormal.length();
    if (length > 0 && Number.isFinite(length)) faceNormal.multiplyScalar(1 / length);
    else faceNormal.set(0, 0, 0);
    faceNormal.toArray(faceNormals, base);
    for (let offset = 0; offset < 3; offset++) {
      const corner = base + offset, id = sourceIndex[corner];
      next[corner] = heads[id]; heads[id] = corner;
    }
  }
  const newIndex = new Uint32Array(cornerCount);
  const baseNormals = new Float32Array(vertexCount * 3);
  const chunkSize = 16384;
  const extraSources = [], extraNormals = [];
  let extraCount = 0;
  const append = (source, normal) => {
    const chunk = Math.floor(extraCount / chunkSize), offset = extraCount % chunkSize;
    if (!extraSources[chunk]) { extraSources.push(new Uint32Array(chunkSize)); extraNormals.push(new Float32Array(chunkSize * 3)); }
    extraSources[chunk][offset] = source;
    extraNormals[chunk].set(normal, offset * 3);
    return vertexCount + extraCount++;
  };
  const cosine = Math.cos(creaseAngle);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    if (heads[vertex] === -1) continue;
    const corners = [];
    for (let corner = heads[vertex]; corner !== -1; corner = next[corner]) corners.push(corner);
    const parents = Int32Array.from(corners, (_, index) => index);
    const find = item => { while (parents[item] !== item) { parents[item] = parents[parents[item]]; item = parents[item]; } return item; };
    const neighbors = new Map();
    // Edge adjacency, rather than every pair at a high-valence fan vertex.
    for (let local = 0; local < corners.length; local++) {
      const corner = corners[local], base = corner - corner % 3, offset = corner % 3;
      if (faceNormals[base] === 0 && faceNormals[base + 1] === 0 && faceNormals[base + 2] === 0) continue;
      for (const neighbor of [sourceIndex[base + (offset + 1) % 3], sourceIndex[base + (offset + 2) % 3]]) {
        if (neighbor === vertex) continue;
        const connected = neighbors.get(neighbor);
        if (connected) {
          for (const other of connected) {
            const otherBase = corners[other] - corners[other] % 3;
            const dot = faceNormals[base] * faceNormals[otherBase] + faceNormals[base + 1] * faceNormals[otherBase + 1] + faceNormals[base + 2] * faceNormals[otherBase + 2];
            if (dot + 1e-12 >= cosine) parents[find(local)] = find(other);
          }
          connected.push(local);
        } else neighbors.set(neighbor, [local]);
      }
    }
    const clusters = new Map();
    a.fromBufferAttribute(position, vertex);
    for (let local = 0; local < corners.length; local++) {
      const corner = corners[local], base = corner - corner % 3, offset = corner % 3;
      b.fromBufferAttribute(position, sourceIndex[base + (offset + 1) % 3]);
      c.fromBufferAttribute(position, sourceIndex[base + (offset + 2) % 3]);
      ab.subVectors(b, a); ac.subVectors(c, a);
      const weight = Math.atan2(faceNormal.crossVectors(ab, ac).length(), ab.dot(ac));
      const root = find(local);
      let cluster = clusters.get(root);
      if (!cluster) { cluster = { normal: [0, 0, 0], corners: [] }; clusters.set(root, cluster); }
      if (Number.isFinite(weight)) for (let axis = 0; axis < 3; axis++) cluster.normal[axis] += faceNormals[base + axis] * weight;
      cluster.corners.push(corner);
    }
    let first = true;
    for (const cluster of clusters.values()) {
      const length = Math.hypot(...cluster.normal);
      if (length > 0) for (let axis = 0; axis < 3; axis++) cluster.normal[axis] /= length;
      const id = first ? vertex : append(vertex, cluster.normal);
      if (first) baseNormals.set(cluster.normal, vertex * 3);
      for (const corner of cluster.corners) newIndex[corner] = id;
      first = false;
    }
  }
  const count = vertexCount + extraCount;
  const sourceFor = vertex => vertex < vertexCount ? vertex : extraSources[Math.floor((vertex - vertexCount) / chunkSize)][(vertex - vertexCount) % chunkSize];
  const remap = attribute => {
    if (attribute.count !== vertexCount) return attribute.clone(attribute.isInterleavedBufferAttribute ? {} : undefined);
    const input = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
    const output = new input.constructor(count * attribute.itemSize);
    const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize;
    const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
    for (let vertex = 0; vertex < count; vertex++) {
      const source = sourceFor(vertex) * stride + offset;
      for (let axis = 0; axis < attribute.itemSize; axis++) output[vertex * attribute.itemSize + axis] = input[source + axis];
    }
    const Attribute = attribute.isInterleavedBufferAttribute ? THREE.BufferAttribute : attribute.constructor;
    const result = new Attribute(output, attribute.itemSize, attribute.normalized, attribute.meshPerAttribute);
    result.name = attribute.name; result.usage = attribute.isInterleavedBufferAttribute ? attribute.data.usage : attribute.usage;
    if (attribute.gpuType !== undefined) result.gpuType = attribute.gpuType;
    return result;
  };
  const result = new THREE.BufferGeometry();
  result.name = geometry.name;
  result.userData = { ...geometry.userData, creaseNormals: { angleDegrees: creaseAngle * 180 / Math.PI, sourceVertices: vertexCount, splitVertices: extraCount } };
  for (const [name, attribute] of Object.entries(geometry.attributes)) if (name !== 'normal') result.setAttribute(name, remap(attribute));
  const normals = new Float32Array(count * 3);
  normals.set(baseNormals);
  for (let chunk = 0; chunk < extraNormals.length; chunk++) normals.set(extraNormals[chunk].subarray(0, Math.min(chunkSize, extraCount - chunk * chunkSize) * 3), (vertexCount + chunk * chunkSize) * 3);
  result.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  result.setIndex(new THREE.BufferAttribute(newIndex, 1));
  for (const group of geometry.groups) result.addGroup(group.start, group.count, group.materialIndex);
  result.setDrawRange(geometry.drawRange.start, geometry.drawRange.count);
  result.boundingBox = geometry.boundingBox?.clone() ?? null;
  result.boundingSphere = geometry.boundingSphere?.clone() ?? null;
  result.morphTargetsRelative = geometry.morphTargetsRelative;
  for (const [name, attributes] of Object.entries(geometry.morphAttributes)) result.morphAttributes[name] = attributes.map(remap);
  return result;
}
