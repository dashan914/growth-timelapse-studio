import * as THREE from 'three';

// Evaluate the complete source mesh once when choosing a photographic preset.
// Rotating its old AABB would include empty space around an asymmetric tail and
// move the visible subject off centre. Growth/clipping and support geometry do
// not participate in this placement measurement.
function visitModelVertices(meshes, modelGroup, yawDeg, supports, rotationOverride, visit) {
  if (!modelGroup || !Number.isFinite(yawDeg) || rotationOverride && (!rotationOverride.isMatrix4 || !rotationOverride.elements.every(Number.isFinite))) return null;
  modelGroup.updateWorldMatrix(true, true);
  const inverse = modelGroup.matrixWorld.clone().invert();
  const rotation = rotationOverride?.clone() || new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(yawDeg));
  const vertex = new THREE.Vector3(), instance = new THREE.Matrix4();
  for (const mesh of meshes || []) {
    if (supports.has(mesh) || !mesh.geometry?.attributes?.position) continue;
    const transform = rotation.clone().multiply(inverse).multiply(mesh.matrixWorld);
    const instances = mesh.isInstancedMesh ? mesh.count : 1;
    for (let item = 0; item < instances; item++) {
      let matrix = transform;
      if (mesh.isInstancedMesh) {
        mesh.getMatrixAt(item, instance);
        matrix = transform.clone().multiply(instance);
      }
      for (let index = 0; index < mesh.geometry.attributes.position.count; index++) {
        mesh.getVertexPosition(index, vertex);
        vertex.applyMatrix4(matrix);
        if (Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z)) visit(vertex);
      }
    }
  }
  return true;
}

export function photographicModelBounds(meshes, modelGroup, yawDeg = 0, supports = new Set(), rotationOverride = null) {
  const bounds=new THREE.Box3();
  if(!visitModelVertices(meshes,modelGroup,yawDeg,supports,rotationOverride,vertex=>bounds.expandByPoint(vertex)))return null;
  return bounds.isEmpty()?null:bounds;
}

/** The same complete source measurement, with real vertices for projected
 * framing and a near-sole anchor so a raised long tail cannot move the feet.
 * Growth visibility, draw ranges and support geometry never affect this pose.
 */
export function photographicModelGeometry(meshes,modelGroup,yawDeg=0,supports=new Set()){
  const count=(meshes||[]).reduce((total,mesh)=>total+(supports.has(mesh)?0:(mesh.geometry?.attributes?.position?.count||0)*(mesh.isInstancedMesh?mesh.count:1)),0);
  if(!count)return null;
  const points=new Float64Array(count*3),bounds=new THREE.Box3();let cursor=0;
  if(!visitModelVertices(meshes,modelGroup,yawDeg,supports,null,vertex=>{
    bounds.expandByPoint(vertex);points[cursor++]=vertex.x;points[cursor++]=vertex.y;points[cursor++]=vertex.z;
  })||bounds.isEmpty())return null;
  const contactBounds=new THREE.Box3(),vertex=new THREE.Vector3();
  const soleLimit=bounds.min.y+(bounds.max.y-bounds.min.y)*.03;
  for(let i=0;i<cursor;i+=3)if(points[i+1]<=soleLimit)contactBounds.expandByPoint(vertex.set(points[i],points[i+1],points[i+2]));
  const contactCenter=contactBounds.getCenter(new THREE.Vector3());contactCenter.y=bounds.min.y;
  return{bounds,points:points.subarray(0,cursor),contactCenter,contactBounds};
}
