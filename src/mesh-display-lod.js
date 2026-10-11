import * as THREE from 'three';
import { MeshoptSimplifier } from '../node_modules/three/examples/jsm/libs/meshopt_simplifier.module.js';

const cancelled = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const raw = (attribute, vertex, component) => attribute.isInterleavedBufferAttribute
  ? attribute.data.array[vertex * attribute.data.stride + attribute.offset + component]
  : attribute.array[vertex * attribute.itemSize + component];
const decoded = (attribute, vertex, component) => attribute.getComponent(vertex, component);
const positive = (value, name) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name}必须是正数。`);
  return value;
};

function fallback(source, sourceTriangles, reason) {
  // Explicit ownership matters: callers must not dispose an unchanged source.
  return { geometry: source, ownsGeometry: false, sourceTriangles, displayTriangles: sourceTriangles,
    errorMm: 0, error: 0, simplified: false, skippedReason: reason, sourceGeometryUnmodified: true };
}

function groupsFor(source, count) {
  if (!source.groups.length) return [{ start: 0, count, materialIndex: 0 }];
  const groups = source.groups.map(group => ({ ...group }));
  let cursor = 0;
  for (const group of [...groups].sort((a,b) => a.start-b.start)) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count) || group.start !== cursor || group.count < 0
      || group.start % 3 || group.count % 3 || !Number.isInteger(group.materialIndex) || group.materialIndex < 0) return null;
    cursor += group.count;
  }
  return cursor === count ? groups : null;
}

/** Attribute-aware, display-only CAD LOD. The bundled meshoptimizer 1.1 uses
 * original vertices; no source positions/normals/UV/colors are updated. Hard
 * seams, holes, material chunks and geometric creases are locked, and a face
 * budget is a soft goal, never permission to exceed the simplifier error limit.
 * Its combined position/attribute metric is approximate, not a certified
 * Hausdorff distance; projected silhouette/color tests remain necessary.
 * Skipped cases explicitly return ownsGeometry:false and the original geometry.
 */
export async function createMeshDisplayLOD(source, {
  maxDeviationMm = .04, sourceUnitScale = 1, targetTriangleBudget = null,
  creaseAngleDegrees = 50, signal = null, onProgress = null,
  chunkSize = 16384, simplifyChunkTriangles = 65536,
  yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)),
  maxWorkingBytes = 512 * 1024 * 1024,
} = {}) {
  cancelled(signal);
  if (!source?.isBufferGeometry || !source.attributes.position || source.attributes.position.itemSize !== 3) throw new TypeError('显示 LOD 需要三维 BufferGeometry。');
  positive(maxDeviationMm, '显示误差'); positive(sourceUnitScale, '源单位毫米比例'); positive(maxWorkingBytes, '处理内存限制');
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(simplifyChunkTriangles) || simplifyChunkTriangles < 1 || simplifyChunkTriangles > 1_000_000 || !Number.isFinite(creaseAngleDegrees) || creaseAngleDegrees < 0 || creaseAngleDegrees > 180) throw new RangeError('显示 LOD 分块或硬边角度无效。');
  if (targetTriangleBudget !== null && (!Number.isInteger(targetTriangleBudget) || targetTriangleBudget < 1)) throw new RangeError('显示三角面预算必须是正整数。');
  if (onProgress !== null && typeof onProgress !== 'function' || typeof yieldControl !== 'function') throw new TypeError('显示 LOD 进度或让出回调无效。');
  const position = source.attributes.position, vertexCount = position.count;
  const cornerCount = source.index?.count ?? vertexCount, sourceTriangles = cornerCount / 3;
  if (!Number.isInteger(vertexCount) || cornerCount % 3) throw new RangeError('显示网格的顶点或三角面数量无效。');
  if (!cornerCount) return fallback(source, 0, 'empty');
  if (source.isInstancedBufferGeometry || Object.keys(source.morphAttributes).length || source.attributes.skinIndex || source.attributes.skinWeight) return fallback(source, sourceTriangles, 'deformed-or-instanced');
  if (source.drawRange.start !== 0 || source.drawRange.count < cornerCount) return fallback(source, sourceTriangles, 'partial-draw-range');
  const groups = groupsFor(source, cornerCount);
  if (!groups) return fallback(source, sourceTriangles, 'incomplete-or-overlapping-material-groups');
  const streams = Object.entries(source.attributes).sort(([a],[b]) => a.localeCompare(b));
  for (const [,attribute] of streams) if (attribute.isFloat16BufferAttribute || attribute.isGLBufferAttribute || attribute.isInstancedBufferAttribute || attribute.count !== vertexCount || !Number.isInteger(attribute.itemSize) || attribute.itemSize < 1 || attribute.itemSize > 16) return fallback(source, sourceTriangles, 'unsupported-vertex-stream');
  // Conservative scratch estimate includes hash buckets and all index/position
  // work. Extra LOD buffers are optional, unlike the original imported CAD.
  if (cornerCount * 112 + vertexCount * 8 > maxWorkingBytes) return fallback(source, sourceTriangles, 'working-memory-budget');
  if (!MeshoptSimplifier.supported) return fallback(source, sourceTriangles, 'wasm-unavailable');
  const report = (phase, completed, total, extra = {}) => { cancelled(signal); onProgress?.({ phase, completed, total, progress: total ? completed / total : 1, ...extra }); };
  const checkpoint = async (phase, completed, total, extra) => { report(phase, completed, total, extra); await yieldControl(); cancelled(signal); };
  report('initialize', 0, 1); await MeshoptSimplifier.ready; cancelled(signal);
  const mapped = new Int32Array(vertexCount).fill(-1), mappedGroup = new Uint32Array(vertexCount);
  const pointers = new Uint32Array(cornerCount), pointerGroups = new Uint32Array(cornerCount), links = new Int32Array(cornerCount).fill(-1);
  const weldedIndex = new Uint32Array(cornerCount), positions = new Float32Array(cornerCount * 3), heads = new Map();
  const bits = new Float64Array(1), words = new Uint32Array(bits.buffer);
  let weldedCount = 0, weldedCorners = 0;
  const hashVertex = (vertex, group) => {
    let hash = Math.imul(group+1, 16777619) >>> 0;
    for (const [,attribute] of streams) for (let c = 0; c < attribute.itemSize; c++) {
      const value = raw(attribute, vertex, c);
      if (!Number.isFinite(value)) throw new RangeError('显示网格包含非有限属性，不能可靠简化。');
      bits[0] = value === 0 ? 0 : value;
      hash = Math.imul(hash ^ words[0], 16777619); hash = Math.imul(hash ^ words[1], 16777619);
    }
    return hash >>> 0;
  };
  const equalVertex = (a,b) => streams.every(([,attribute]) => {
    for (let c=0;c<attribute.itemSize;c++) if (raw(attribute,a,c) !== raw(attribute,b,c)) return false;
    return true;
  });
  try {
    report('weld', 0, cornerCount);
    for (let groupId=0;groupId<groups.length;groupId++) {
      const group = groups[groupId];
      for (let corner=group.start;corner<group.start+group.count;corner++) {
        const vertex = source.index ? source.index.getX(corner) : corner;
        if (!Number.isInteger(vertex) || vertex < 0 || vertex >= vertexCount) throw new RangeError('显示网格引用了无效顶点。');
        let id = mappedGroup[vertex] === groupId+1 ? mapped[vertex] : -1;
        if (id < 0) {
          const hash = hashVertex(vertex, groupId); let match = heads.get(hash) ?? -1;
          while (match >= 0 && !(pointerGroups[match] === groupId && equalVertex(vertex,pointers[match]))) match = links[match];
          if (match >= 0) id = match;
          else {
            id = weldedCount++; pointers[id]=vertex; pointerGroups[id]=groupId;
            links[id] = heads.get(hash) ?? -1; heads.set(hash,id);
            for (let axis=0;axis<3;axis++) {
              const value = decoded(position,vertex,axis)*sourceUnitScale;
              if (!Number.isFinite(value) || Math.abs(value)>1e9) throw new RangeError('显示网格的毫米坐标范围无效。');
              positions[id*3+axis]=value;
            }
          }
          mapped[vertex]=id; mappedGroup[vertex]=groupId+1;
        }
        weldedIndex[corner]=id;
        if (++weldedCorners%chunkSize===0) await checkpoint('weld',weldedCorners,cornerCount);
      }
    }
    await checkpoint('weld',cornerCount,cornerCount,{vertices:weldedCount});
    const packedPositions = positions.subarray(0,weldedCount*3);
    const locks = new Uint8Array(weldedCount), remap = MeshoptSimplifier.generatePositionRemap(packedPositions,3);
    const multiplicity = new Uint32Array(weldedCount);
    for (let i=0;i<weldedCount;i++) multiplicity[remap[i]]++;
    for (let i=0;i<weldedCount;i++) if (multiplicity[remap[i]]>1) locks[i]=1;
    // Preserve an existing hard geometric fan even when the incoming indexed
    // mesh has averaged normals. No normal reconstruction or smoothing occurs.
    // A half-angle cone around the first face bounds every pair in the fan.
    const firstNormals = new Float32Array(weldedCount*3), seen = new Uint8Array(weldedCount), cosine = Math.cos(creaseAngleDegrees*Math.PI/360);
    const normal = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const categorical = streams.filter(([name]) => name === 'toolIndex' || name === 'color');
    report('protect',0,cornerCount);
    for (let corner=0;corner<cornerCount;corner+=3) {
      const ids = [weldedIndex[corner],weldedIndex[corner+1],weldedIndex[corner+2]];
      a.fromArray(packedPositions,ids[0]*3);b.fromArray(packedPositions,ids[1]*3);c.fromArray(packedPositions,ids[2]*3);
      normal.crossVectors(b.sub(a),c.sub(a)).normalize();
      for (const id of ids) {
        if (!seen[id]) {normal.toArray(firstNormals,id*3);seen[id]=1;}
        else if (normal.dot(a.fromArray(firstNormals,id*3)) < cosine-1e-7) locks[id]=1;
      }
      // Discrete painted triangles must never become interpolated triangles
      // crossing a tool/color change. Mixed triangles are conservatively kept.
      for (const [,attribute] of categorical) {
        let mixed=false;
        for (let axis=0;axis<attribute.itemSize;axis++) if (raw(attribute,pointers[ids[0]],axis)!==raw(attribute,pointers[ids[1]],axis) || raw(attribute,pointers[ids[0]],axis)!==raw(attribute,pointers[ids[2]],axis)) mixed=true;
        if (mixed) for (const id of ids) locks[id]=1;
      }
      if ((corner+3)%chunkSize<3) await checkpoint('protect',corner+3,cornerCount);
    }
    const attributeStreams = streams.filter(([name]) => ['normal','color','uv','toolIndex'].includes(name));
    const stride = attributeStreams.reduce((sum,[,attribute]) => sum+attribute.itemSize,0), weights=[];
    const attributes = new Float32Array(weldedCount*stride);
    for (const [name,attribute] of attributeStreams) for (let axis=0;axis<attribute.itemSize;axis++) weights.push(name==='normal'?.5:name==='color'?4:name==='toolIndex'?16:1);
    for (let vertex=0;vertex<weldedCount;vertex++) {
      let offset=vertex*stride;
      for (const [,attribute] of attributeStreams) for (let axis=0;axis<attribute.itemSize;axis++) attributes[offset++]=decoded(attribute,pointers[vertex],axis);
      if ((vertex+1)%chunkSize===0) await checkpoint('attributes',vertex+1,weldedCount);
    }
    const outputChunks=[], outputGroupCounts=new Uint32Array(groups.length); let displayCornerCount=0,errorMm=0,processedChunks=0;
    const maxChunkCorners=simplifyChunkTriangles*3,totalChunks=groups.reduce((sum,group)=>sum+Math.ceil(group.count/maxChunkCorners),0);
    report('simplify',0,totalChunks);
    for (let groupId=0;groupId<groups.length;groupId++) {
      const group=groups[groupId];
      for(let start=group.start;start<group.start+group.count;start+=maxChunkCorners) {
        cancelled(signal);
        const input=weldedIndex.subarray(start,Math.min(start+maxChunkCorners,group.start+group.count));
        const target=targetTriangleBudget===null?0:Math.min(input.length,Math.floor(targetTriangleBudget*input.length/cornerCount)*3);
        let output=input,error=0;
        if (input.length>3 && target<input.length) {
          // Chunk borders are locked, preventing cracks between independently
          // simplified chunks. WASM itself is synchronous; cancellation/yields
          // happen between these bounded calls rather than after an entire CAD.
          [output,error]=MeshoptSimplifier.simplifyWithAttributes(input,packedPositions,3,attributes,stride,weights,locks,target,maxDeviationMm,['LockBorder','ErrorAbsolute','Sparse']);
          if (!Number.isFinite(error) || error>maxDeviationMm*1.001) {output=input;error=0;}
        }
        outputChunks.push(output);outputGroupCounts[groupId]+=output.length;
        displayCornerCount+=output.length;errorMm=Math.max(errorMm,error);
        await checkpoint('simplify',++processedChunks,totalChunks,{displayTriangles:displayCornerCount/3,errorMm});
      }
    }
    const outputIndex = new Uint32Array(displayCornerCount), compact = new Int32Array(weldedCount).fill(-1), used=[];
    let cursor=0;
    for (const chunk of outputChunks) for (const id of chunk) {
      if (compact[id]<0) {compact[id]=used.length;used.push(pointers[id]);}
      outputIndex[cursor++]=compact[id];
      if (cursor%chunkSize===0) await checkpoint('compact',cursor,displayCornerCount);
    }
    const geometry=new THREE.BufferGeometry();
    try {
      geometry.name=source.name;
      for (const [name,attribute] of streams) {
        const input=attribute.isInterleavedBufferAttribute?attribute.data.array:attribute.array;
        const output=new input.constructor(used.length*attribute.itemSize);
        for (let vertex=0;vertex<used.length;vertex++) {
          for (let axis=0;axis<attribute.itemSize;axis++) output[vertex*attribute.itemSize+axis]=raw(attribute,used[vertex],axis);
          if ((vertex+1)%chunkSize===0) await checkpoint('copy',vertex+1,used.length,{attribute:name});
        }
        const next=new THREE.BufferAttribute(output,attribute.itemSize,attribute.normalized);
        next.name=attribute.name;next.setUsage(attribute.isInterleavedBufferAttribute?attribute.data.usage:attribute.usage);
        if (attribute.gpuType!==undefined)next.gpuType=attribute.gpuType;
        geometry.setAttribute(name,next);
      }
      geometry.setIndex(new THREE.BufferAttribute(outputIndex,1));cursor=0;
      if(source.groups.length)groups.forEach((group,id)=>{geometry.addGroup(cursor,outputGroupCounts[id],group.materialIndex);cursor+=outputGroupCounts[id];});
      geometry.setDrawRange(0,displayCornerCount);geometry.computeBoundingBox();geometry.computeBoundingSphere();
      const stats={sourceTriangles,displayTriangles:displayCornerCount/3,errorMm,errorMetric:'approximate-position-and-attribute',sourceUnitScale,maxDeviationMm,
        lockedVertices:locks.reduce((sum,value)=>sum+Number(Boolean(value)),0),targetTriangleBudget,
        targetReached:targetTriangleBudget===null||displayCornerCount/3<=targetTriangleBudget,
        sourceGeometryUnmodified:true,normalsRecomputed:false,materialBoundariesProtected:true,displayOnly:true,algorithm:'meshoptimizer-bundled-1.1'};
      geometry.userData={...source.userData,meshDisplayLOD:{...stats}};
      report('complete',1,1,stats);
      return {geometry,ownsGeometry:true,...stats,error:errorMm,simplified:stats.displayTriangles<sourceTriangles};
    } catch(error) {geometry.dispose();throw error;}
  } catch(error) {
    if (error instanceof RangeError && /allocation|array buffer|out of memory/i.test(error.message)) return fallback(source,sourceTriangles,'allocation-failed');
    throw error;
  }
}

/** Conservative projected bound for a physical-mm LOD error. Uses the actual
 * cropped/off-axis matrix and transformed source bounds, not a nominal FOV.
 * Near-plane crossings reject LOD rather than claiming a screen-space bound.
 */
export function projectedMeshDisplayErrorPx({ errorMm, sourceUnitScale=1, geometry, camera, worldMatrix=new THREE.Matrix4(), width, height }) {
  if (!Number.isFinite(errorMm)||errorMm<0||!Number.isFinite(sourceUnitScale)||sourceUnitScale<=0||!camera?.isCamera||!geometry?.attributes.position||!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0||worldMatrix.elements?.some(value=>!Number.isFinite(value))) throw new TypeError('显示 LOD 的像素误差参数无效。');
  const sourceBounds=geometry.boundingBox?.clone()||new THREE.Box3().setFromBufferAttribute(geometry.attributes.position);
  const cameraWorld=new THREE.Matrix4().compose(camera.position,camera.quaternion,camera.scale);
  const view=camera.parent?camera.matrixWorld.clone().invert():cameraWorld.invert();
  const modelView=view.multiply(worldMatrix),p=camera.projectionMatrix.elements;
  const linear=new THREE.Matrix3().setFromMatrix4(modelView).elements;
  // A^T A's infinity norm bounds its largest eigenvalue. Unlike a Frobenius
  // estimate this is exact for uniform rotations/scales, yet handles shear.
  let squaredBound=0;
  for(let column=0;column<3;column++){
    let rowSum=0;
    for(let other=0;other<3;other++)rowSum+=Math.abs(linear[column*3]*linear[other*3]+linear[column*3+1]*linear[other*3+1]+linear[column*3+2]*linear[other*3+2]);
    squaredBound=Math.max(squaredBound,rowSum);
  }
  const physicalError=errorMm/sourceUnitScale*Math.sqrt(squaredBound);
  if(physicalError===0)return 0;
  const fx=width*.5*Math.abs(p[0]),fy=height*.5*Math.abs(p[5]);
  let nearest=Infinity,radialMax=0;
  const point=new THREE.Vector3();
  for(const x of[sourceBounds.min.x,sourceBounds.max.x])for(const y of[sourceBounds.min.y,sourceBounds.max.y])for(const z of[sourceBounds.min.z,sourceBounds.max.z]){
    point.set(x,y,z).applyMatrix4(modelView);
    const depth=-point.z-physicalError;nearest=Math.min(nearest,depth);
    // Include the displacement ball when bounding derivatives between the
    // original and LOD surface. Projected box interiors lie in the convex hull
    // of the positive-depth corner projections, so corner radii are sufficient.
    radialMax=Math.max(radialMax,(Math.hypot(point.x,point.y)+physicalError)/depth);
  }
  if (nearest<=Math.max(0,camera.near)) return Infinity;
  const maxFocal=Math.max(fx,fy);
  if(camera.isOrthographicCamera)return maxFocal*physicalError;
  return maxFocal/nearest*Math.sqrt(1+radialMax*radialMax)*physicalError;
}

export function isMeshDisplayLODWithinScreenError(parameters) {
  const maxPixels=parameters.maxPixels??.5;
  if (!Number.isFinite(maxPixels)||maxPixels<=0||maxPixels>.5) throw new RangeError('显示 LOD 像素误差必须大于零且不超过 0.5 像素。');
  return projectedMeshDisplayErrorPx(parameters)<=maxPixels;
}
