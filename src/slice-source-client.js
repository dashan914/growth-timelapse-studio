import * as THREE from '../node_modules/three/build/three.module.js';
export { SLICE_SOURCE_REVISION } from './slice-source-version.js';

const abortError = () => new DOMException('Aborted', 'AbortError');
const excluded = node => node.userData?.growthTransient || node.userData?.growthPrintLayer || node.userData?.growthStencil || node.userData?.isSupport;
const world = object => {
  const matrix = object.matrixAutoUpdate ? new THREE.Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix.clone();
  return object.parent ? world(object.parent).multiply(matrix) : matrix;
};
const nextPaint = () => new Promise(resolve => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(resolve) : setTimeout(resolve, 0));
const finiteMatrix = matrix => matrix.toArray().every(value => Number.isFinite(value) && Math.abs(value) <= 1e7);
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const color = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null;

/** Copy only the actual posed mesh, discrete material facts and known relative
 * matrices. No scene serialization, textures, live buffers or remote URLs are
 * given to the worker. Each large copy yields so cancellation stays usable. */
export async function captureSliceSourceSnapshot(studio, {
  signal, onPhase = () => {}, onProgress = () => {}, yieldNow = nextPaint,
  batchVertices = 8192, batchIndices = 32768, maxTriangles = 5_000_000, maxTools = 16,
  maxXMLBytes = 256 * 1024 * 1024, maxSnapshotBytes = 384 * 1024 * 1024,
} = {}) {
  checkAbort(signal);
  for (const [name, value, maximum] of [['batchVertices', batchVertices, 1_000_000], ['batchIndices', batchIndices, 1_000_000],
    ['maxTriangles', maxTriangles, 5_000_000], ['maxTools', maxTools, 256], ['maxXMLBytes', maxXMLBytes, 256 * 1024 * 1024], ['maxSnapshotBytes', maxSnapshotBytes, 384 * 1024 * 1024]]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`后台切片复制预算 ${name} 无效。`);
  }
  const orientation = studio?.orientation, root = orientation?.children.find(node => !excluded(node));
  if (!root) throw new Error('没有可切片的完整模型。');
  const units = Number(studio.metadata?.sourceUnitsToMm);
  if (!Number.isFinite(units) || units <= 0) throw new Error('模型单位未知，无法保持真实层高。');
  const candidates = [];
  const visit = node => { if (excluded(node)) return; if (node.isMesh) candidates.push(node); node.children?.forEach(visit); };
  visit(root);
  if (!candidates.length) throw new Error('没有可切片的完整模型。');
  const parentInverse = world(orientation).invert();
  const toolColors = {};
  for (const [tool, value] of Object.entries(studio.options?.toolColors || {})) {
    if (/^\d+$/.test(tool) && Number(tool) <= 65535 && color(value)) toolColors[tool] = color(value);
  }
  const options = { preserveMaterials: studio.options?.preserveMaterials !== false,
    color: color(studio.options?.color) || '#d6d6d6', toolColors };
  let triangleCount = 0, totalVertices = 0, copiedVertices = 0, snapshotBytes = 0;
  const descriptors = [];
  for (const node of candidates) {
    const geometry = node.geometry, position = geometry?.attributes?.position, index = geometry?.index, vertexColor = geometry?.attributes?.color;
    if (!position || !Number.isInteger(position.count) || position.count < 1) throw new Error('模型缺少完整顶点。');
    const count = index?.count ?? position.count;
    if (!Number.isInteger(count) || count < 3 || count % 3) throw new Error('模型不是完整三角面网格。');
    const instanceCount = node.isInstancedMesh ? node.count : 1;
    if (!Number.isInteger(instanceCount) || instanceCount < 1 || instanceCount > 4096) throw new Error('模型实例超过切片预算，不会省略实例。');
    triangleCount += count / 3 * instanceCount;
    if (triangleCount > maxTriangles) throw new Error('模型超过完整切片面数预算，不会减面。');
    if(vertexColor&&(vertexColor.count!==position.count||![3,4].includes(vertexColor.itemSize)))throw new Error('顶点颜色与完整模型顶点不对应。');
    snapshotBytes += position.count * 3 * 8 + (index ? count * 4 : 0) + (vertexColor ? vertexColor.count*vertexColor.itemSize*8 : 0) + (node.isInstancedMesh ? instanceCount * 16 * 8 : 0);
    if (snapshotBytes > maxSnapshotBytes) throw new Error('完整网格复制超过内存预算，不会截断模型或降低面数。');
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const materialFacts = materials.map(material => {
      if (!material?.isMaterial) throw new Error('模型缺少材质。');
      const source = studio._sourceMaterials?.get(material) || material;
      const hex = source.color?.getHexString ? '#' + source.color.getHexString() : options.color;
      const toolIndex = source.toolIndex ?? material.userData?.toolIndex;
      return { color: color(hex) || options.color, linearColor: source.color ? [source.color.r,source.color.g,source.color.b] : null, toolIndex: Number.isInteger(toolIndex) ? toolIndex : null,
        hasTexture: Boolean(source.map), hasVertexColors: Boolean(source.vertexColors) };
    });
    const matrix = parentInverse.clone().multiply(world(node));
    if (!finiteMatrix(matrix) || Math.abs(matrix.determinant()) < 1e-15) throw new Error('模型变换无效或不可逆，无法准确切片。');
    const groups = Array.isArray(node.material) ? geometry.groups.map(group => ({ start: group.start, count: group.count, materialIndex: group.materialIndex })) : [{ start: 0, count, materialIndex: 0 }];
    totalVertices += position.count;
    descriptors.push({ node, geometry, position, index, vertexColor, matrix: matrix.toArray(), groups, materials: materialFacts, materialArray: Array.isArray(node.material), instanceCount });
  }
  onPhase('copying');
  const meshes = [], point = new THREE.Vector3();
  for (const descriptor of descriptors) {
    const { node, position, index, vertexColor, instanceCount } = descriptor;
    const positions = new Float64Array(position.count * 3);
    for (let start = 0; start < position.count; start += batchVertices) {
      checkAbort(signal);
      const end = Math.min(position.count, start + batchVertices);
      for (let vertex = start; vertex < end; vertex++) {
        // This bakes the static skin/morph pose using the same Three API as
        // the synchronous source exporter, without changing live geometry.
        if (typeof node.getVertexPosition === 'function') node.getVertexPosition(vertex, point);
        else point.fromBufferAttribute(position, vertex);
        if (![point.x, point.y, point.z].every(value => Number.isFinite(value) && Math.abs(value) < 1e7)) throw new Error('模型包含无效顶点。');
        positions[vertex * 3] = point.x; positions[vertex * 3 + 1] = point.y; positions[vertex * 3 + 2] = point.z;
      }
      copiedVertices += end - start; onProgress({ phase: 'copying', copiedVertices, totalVertices });
      await yieldNow();
    }
    let indices = null;
    if (index) {
      indices = new Uint32Array(index.count);
      for (let start = 0; start < index.count; start += batchIndices) {
        checkAbort(signal);
        for (let at = start; at < Math.min(index.count, start + batchIndices); at++) {
          const vertex = index.getX(at);
          if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) throw new Error('模型包含无效面索引。');
          indices[at] = vertex;
        }
        await yieldNow();
      }
    }
    let colors=null,colorItemSize=null;
    if(vertexColor){
      colorItemSize=vertexColor.itemSize;colors=new Float64Array(vertexColor.count*colorItemSize);
      for(let start=0;start<vertexColor.count;start+=batchVertices){
        checkAbort(signal);
        for(let vertex=start;vertex<Math.min(vertexColor.count,start+batchVertices);vertex++){
          const values=[vertexColor.getX(vertex),vertexColor.getY(vertex),vertexColor.getZ(vertex),...(colorItemSize===4?[vertexColor.getW(vertex)]:[])];
          if(values.some(value=>!Number.isFinite(value)))throw new Error('模型含无效顶点颜色。');
          colors.set(values,vertex*colorItemSize);
        }
        await yieldNow();
      }
    }
    let instances = null;
    if (node.isInstancedMesh) {
      instances = new Float64Array(instanceCount * 16);
      const matrix = new THREE.Matrix4();
      for (let instance = 0; instance < instanceCount; instance++) {
        node.getMatrixAt(instance, matrix);
        if (!finiteMatrix(matrix) || Math.abs(matrix.determinant()) < 1e-15) throw new Error('模型实例变换无效，不会省略实例。');
        instances.set(matrix.elements, instance * 16);
        if (instance % 256 === 255) { await yieldNow(); checkAbort(signal); }
      }
    }
    meshes.push({ positions, indices, colors, colorItemSize, instances, matrix: descriptor.matrix, groups: descriptor.groups, materials: descriptor.materials, materialArray: descriptor.materialArray });
  }
  checkAbort(signal);
  return { schemaVersion: 1, metadata: { sourceUnitsToMm: units, name: String(studio.metadata?.name || '完整模型') }, options, meshes,
    limits: { maxTriangles, maxTools, maxXMLBytes }, triangleCount, snapshotBytes };
}

export function sliceSourceSnapshotTransferables(snapshot) {
  return [...new Set(snapshot.meshes.flatMap(mesh => [mesh.positions?.buffer, mesh.indices?.buffer, mesh.colors?.buffer, mesh.instances?.buffer].filter(Boolean)))];
}

export async function createSliceSourceInWorker(studio, {
  preset = 'h2c', signal, onPhase = () => {}, onProgress = () => {}, WorkerClass = globalThis.Worker, ...captureOptions
} = {}) {
  if (typeof WorkerClass !== 'function') throw new Error('当前浏览器没有后台切片准备能力，请使用支持 Worker 的浏览器。');
  const snapshot = await captureSliceSourceSnapshot(studio, { ...captureOptions, signal, onPhase, onProgress });
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const worker = new WorkerClass(new URL('./slice-source-worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const stop = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const fail = error => { if (settled) return; settled = true; stop(); reject(error); };
    const abort = () => fail(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = event => fail(new Error(event.message || '后台切片副本准备失败。'));
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data?.phase === 'complete') { settled = true; stop(); resolve(data.source); }
      else if (data?.phase === 'error') fail(new Error(data.message || '后台切片副本准备失败。'));
      else if (typeof data?.phase === 'string') onPhase(data.phase);
    };
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage({ snapshot, preset }, sliceSourceSnapshotTransferables(snapshot)); }
    catch (error) { fail(error); }
  });
}
