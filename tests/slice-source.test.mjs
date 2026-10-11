import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {unzipSync,strFromU8} from 'three/addons/libs/fflate.module.js';
import {createSliceSource} from '../src/slice-source.js';

function fixture(){
  const outer=new THREE.Group(),orientation=new THREE.Group(),root=new THREE.Group();outer.add(orientation);orientation.add(root);
  outer.scale.setScalar(2);outer.position.set(5,20,-7);orientation.rotation.y=.3;
  for(const [x,color] of [[-.01,'#ff3300'],[.01,'#23599c']]){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(.01,.02,.012),new THREE.MeshStandardMaterial({color}));mesh.position.x=x;root.add(mesh);
  }
  const ghost=new THREE.Mesh(new THREE.BoxGeometry(20,20,20),new THREE.MeshBasicMaterial());ghost.userData.growthStencil=true;root.add(ghost);
  return{orientation,metadata:{sourceUnitsToMm:1000,name:'两色 <box>'},options:{preserveMaterials:true},root};
}

test('full slicing copy preserves triangles/discrete materials and explicitly maps placed printer coordinates to source units',async()=>{
  const studio=fixture(),before=studio.root.children[0].geometry.attributes.position.array.slice();
  const source=createSliceSource(studio,{preset:'h2c'});
  assert.equal(source.triangles,24);assert.equal(source.parts,1);assert.equal(source.sourceMeshes,2);assert.equal(source.geometrySimplified,false);
  assert.deepEqual(source.toolColors,['#ff3300','#23599c']);
  const entries=unzipSync(new Uint8Array(await source.blob.arrayBuffer())),model=strFromU8(entries['3D/3dmodel.model']),settings=strFromU8(entries['Metadata/model_settings.config']);
  assert.equal((model.match(/<triangle /g)||[]).length,24);
  assert.match(model,/paint_color="8"/);assert.match(settings,/两色 &lt;box&gt;/);
  const placement=model.match(/transform="1 0 0 0 1 0 0 0 1 ([^"]+)"/)[1].split(' ').map(Number);
  const v=model.match(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/).slice(1).map(Number);
  const original=new THREE.Vector3().fromBufferAttribute(studio.root.children[0].geometry.attributes.position,0).add(studio.root.children[0].position);
  const recovered=new THREE.Vector3(...v).add(new THREE.Vector3(...placement)).applyMatrix4(new THREE.Matrix4().fromArray(source.printerToSource));
  assert.ok(original.distanceTo(recovered)<1e-10);
  assert.deepEqual(studio.root.children[0].geometry.attributes.position.array,before);
  assert.throws(()=>createSliceSource(studio,{maxXMLBytes:100}),/内存预算/);
});

test('slicing refuses to omit faces or excess colors and identifies texture-to-filament inference',()=>{
  const studio=fixture();assert.throws(()=>createSliceSource(studio,{maxTriangles:12}),/不会减面/);
  assert.throws(()=>createSliceSource(studio,{maxTools:1}),/实际涂色/);
  studio.root.children[0].material.map=new THREE.Texture();
  assert.match(createSliceSource(studio).warnings[0],/实际耗材编号/);
  const mesh=studio.root.children[0];mesh.material=[mesh.material];mesh.geometry.clearGroups();
  assert.throws(()=>createSliceSource(studio),/未分配/);
});
