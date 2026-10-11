import { createMeshDisplayLOD, isMeshDisplayLODWithinScreenError } from './mesh-display-lod.js';

const records = new WeakMap();
const abortIfNeeded = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };

function sourceSignature(geometry) {
  const streams = Object.entries(geometry.attributes).map(([name,attribute]) => {
    const data=attribute.isInterleavedBufferAttribute?attribute.data:attribute;
    return {name,attribute,data,array:data.array,version:data.version,count:attribute.count,itemSize:attribute.itemSize,
      normalized:attribute.normalized,offset:attribute.offset,stride:data.stride,gpuType:attribute.gpuType};
  });
  return {streams,index:geometry.index,indexArray:geometry.index?.array,indexVersion:geometry.index?.version,
    groups:JSON.stringify(geometry.groups),drawStart:geometry.drawRange.start,drawCount:geometry.drawRange.count};
}

function signatureMatches(geometry,signature) {
  if(geometry.index!==signature.index||geometry.index?.array!==signature.indexArray||geometry.index?.version!==signature.indexVersion
    ||JSON.stringify(geometry.groups)!==signature.groups||geometry.drawRange.start!==signature.drawStart||geometry.drawRange.count!==signature.drawCount
    ||Object.keys(geometry.attributes).length!==signature.streams.length)return false;
  for(const entry of signature.streams){
    const attribute=geometry.attributes[entry.name],data=attribute?.isInterleavedBufferAttribute?attribute.data:attribute;
    if(attribute!==entry.attribute||data!==entry.data||data?.array!==entry.array||data.version!==entry.version
      ||attribute.count!==entry.count||attribute.itemSize!==entry.itemSize||attribute.normalized!==entry.normalized
      ||attribute.offset!==entry.offset||data.stride!==entry.stride||attribute.gpuType!==entry.gpuType)return false;
  }
  return true;
}

function eligible(mesh,root) {
  if(!mesh.isMesh||mesh.isInstancedMesh||mesh.isSkinnedMesh||!mesh.geometry?.isBufferGeometry)return false;
  if(mesh.userData.printPathImpostor||mesh.geometry.userData.printPathImpostor||mesh.geometry.userData.printSurfaceLOD)return false;
  let node=mesh;
  while(node){
    if(node.userData.isSupport||node.userData.growthStencil||node.userData.growthTransient||node.userData.growthPrintLayer)return false;
    if(node===root)break;node=node.parent;
  }
  const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
  return !materials.some(material=>material?.transparent&&material.opacity<1);
}

function canAttach(mesh) {
  const descriptor=Object.getOwnPropertyDescriptor(mesh.userData,'meshDisplayLOD');
  return descriptor?descriptor.configurable===true:Object.isExtensible(mesh.userData);
}

function detach(mesh,metadata,{dispose=true}={}) {
  const record=records.get(metadata);
  if(!record)return null;
  if(mesh.geometry===record.geometry&&record.geometry!==metadata.sourceGeometry)mesh.geometry=metadata.sourceGeometry;
  if(mesh.userData.meshDisplayLOD===metadata)delete mesh.userData.meshDisplayLOD;
  records.delete(metadata);record.users.delete(mesh);
  if(record.users.size||record.disposed||!record.ownsGeometry)return null;
  record.disposed=true;
  if(dispose)record.geometry.dispose();
  return record.geometry;
}

/** Prepare optional display copies while the imported CAD stays unchanged.
 * Source meshes continue using their original geometry until a bounded frame
 * swap is requested. Commit is atomic: cancellation/failure disposes only newly
 * created LOD copies and leaves earlier attached records intact. The metadata
 * property is non-enumerable so Object3D.clone/GLTF export never copies caches.
 */
export async function prepareCADDisplayLODs(root, {
  sourceUnitScale=1,signal=null,onProgress=null,maxDeviationMm=.04,targetTriangleBudget=null,
  ...lodOptions
}={}) {
  abortIfNeeded(signal);
  if(!root?.traverse)throw new TypeError('CAD 显示优化需要 Object3D 根节点。');
  if(!Number.isFinite(sourceUnitScale)||sourceUnitScale<=0)throw new RangeError('CAD 源单位毫米比例无效。');
  if(onProgress!==null&&typeof onProgress!=='function')throw new TypeError('CAD 显示优化进度回调无效。');
  const meshes=[];root.traverse(mesh=>{if(eligible(mesh,root))meshes.push(mesh);});
  const policyKey=JSON.stringify({sourceUnitScale,maxDeviationMm,targetTriangleBudget,creaseAngleDegrees:lodOptions.creaseAngleDegrees??50,
    simplifyChunkTriangles:lodOptions.simplifyChunkTriangles??65536,maxWorkingBytes:lodOptions.maxWorkingBytes??512*1024*1024});
  const bySource=new Map(),staged=[],created=new Set();
  const notify=event=>{abortIfNeeded(signal);onProgress?.(event);abortIfNeeded(signal);};
  notify({phase:'cad-lod',completed:0,total:meshes.length,progress:meshes.length?0:1});
  try{
    for(let index=0;index<meshes.length;index++){
      const mesh=meshes[index],old=mesh.userData.meshDisplayLOD,oldRecord=records.get(old);
      // An unowned imported field must not be mistaken for an executable cache.
      if(old&&!oldRecord||!canAttach(mesh)){staged.push({mesh,conflict:true});continue;}
      const source=oldRecord?old.sourceGeometry:mesh.geometry;
      let record=bySource.get(source),reuse=false;
      if(!record&&oldRecord&&!oldRecord.disposed&&old.policyKey===policyKey&&signatureMatches(source,oldRecord.signature)){
        record=oldRecord;reuse=true;bySource.set(source,record);
      }
      if(!record){
        const signature=sourceSignature(source);
        const result=await createMeshDisplayLOD(source,{...lodOptions,sourceUnitScale,maxDeviationMm,targetTriangleBudget,signal,
          onProgress:event=>notify({phase:'cad-lod',completed:index,total:meshes.length,progress:index/Math.max(1,meshes.length),
            meshName:mesh.name,detailPhase:event.phase,detailCompleted:event.completed,detailTotal:event.total,meshProgress:event.progress})});
        record={...result,sourceGeometry:source,signature,users:new Set(),disposed:false};
        bySource.set(source,record);created.add(record);
        if(!signatureMatches(source,signature))throw new Error('原始 CAD 在显示优化期间发生变化，已保留当前源模型。');
      }
      staged.push({mesh,record,old,reuse:reuse||record===oldRecord});
      notify({phase:'cad-lod',completed:index+1,total:meshes.length,progress:(index+1)/Math.max(1,meshes.length),
        meshName:mesh.name,sourceTriangles:record.sourceTriangles,displayTriangles:record.displayTriangles});
    }
    abortIfNeeded(signal);
    for(const item of staged)if(!item.conflict&&(!canAttach(item.mesh)||!signatureMatches(item.record.sourceGeometry,item.record.signature)))throw new Error('原始 CAD 在显示优化期间发生变化，已保留当前源模型。');
    // No await occurs after this point. Store source/owned information without
    // changing geometry, bounding boxes, normalization, normals or scene pose.
    for(const item of staged){
      if(item.conflict||item.reuse)continue;
      const {mesh,record,old}=item;
      if(records.has(old))detach(mesh,old);
      const metadata={sourceGeometry:record.sourceGeometry,geometry:record.geometry,ownsGeometry:record.ownsGeometry,
        sourceTriangles:record.sourceTriangles,displayTriangles:record.displayTriangles,errorMm:record.errorMm,
        gateErrorMm:Math.max(record.errorMm,record.maxDeviationMm||0),sourceUnitScale,policyKey,
        simplified:record.simplified,skippedReason:record.skippedReason||null,displayOnly:true};
      record.users.add(mesh);records.set(metadata,record);
      Object.defineProperty(mesh.userData,'meshDisplayLOD',{value:metadata,enumerable:false,writable:true,configurable:true});
    }
    return {meshes:staged.filter(item=>!item.conflict).map(item=>item.mesh),
      sourceTriangles:staged.reduce((sum,item)=>sum+(item.record?.sourceTriangles||0),0),
      displayTriangles:staged.reduce((sum,item)=>sum+(item.record?.displayTriangles||0),0),
      uniqueGeometries:bySource.size,simplifiedMeshes:staged.filter(item=>item.record?.simplified).length,
      skippedMeshes:staged.filter(item=>item.conflict||!item.record?.simplified).length,sourceGeometryUnmodified:true};
  }catch(error){
    for(const record of created)if(record.ownsGeometry&&!record.users.size&&!record.disposed){record.disposed=true;record.geometry.dispose();}
    throw error;
  }
}

/** Temporary, synchronous frame swap. width/height are the actual draw pixel
 * dimensions, including export sampling/retina. Caller updates mesh world
 * matrices before invoking and always restores in finally. Changed source
 * streams fall back to the original CAD until explicitly prepared again.
 */
export function beginCADDisplayFrame(meshes,{camera,width,height,enabled=true,maxPixels=.5}={}) {
  const swapped=[];
  let restored=false;
  const restore=()=>{
    if(restored)return;restored=true;
    for(let index=swapped.length-1;index>=0;index--){
      const [mesh,source,lod]=swapped[index];if(mesh.geometry===lod)mesh.geometry=source;
    }
  };
  restore.swappedMeshes=0;
  if(!enabled)return restore;
  try{
    for(const mesh of meshes||[]){
      const metadata=mesh.userData?.meshDisplayLOD,record=records.get(metadata);
      if(!record||record.disposed||!record.ownsGeometry||!record.simplified||mesh.geometry!==metadata.sourceGeometry||!eligible(mesh,null)
        ||!signatureMatches(metadata.sourceGeometry,record.signature))continue;
      if(!isMeshDisplayLODWithinScreenError({errorMm:metadata.gateErrorMm,sourceUnitScale:metadata.sourceUnitScale,
        geometry:metadata.sourceGeometry,camera,worldMatrix:mesh.matrixWorld,width,height,maxPixels}))continue;
      swapped.push([mesh,mesh.geometry,record.geometry]);mesh.geometry=record.geometry;
    }
    restore.swappedMeshes=swapped.length;return restore;
  }catch(error){restore();throw error;}
}

/** Release an attached display cache, never the source CAD. For disposeTree
 * collection use {dispose:false}; the returned geometry is owned and appears
 * only when the last sharing mesh releases it, so it can be added to a Set.
 */
export function disposeCADDisplayLOD(mesh,options={}) {
  return detach(mesh,mesh.userData?.meshDisplayLOD,options);
}
