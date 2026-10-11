import * as THREE from '../node_modules/three/build/three.module.js';
import { createSliceSource } from './slice-source.js';

/** Rebuild only the already-baked static coordinates in a detached scene.
 * The original rendering materials, textures and live arrays never enter it. */
export function buildSliceSourceFromSnapshot(snapshot, { preset = 'h2c' } = {}) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.meshes) || !snapshot.meshes.length || snapshot.meshes.length > 10000) throw new Error('完整网格快照格式无效。');
  const units = Number(snapshot.metadata?.sourceUnitsToMm);
  if (!Number.isFinite(units) || units <= 0) throw new Error('来源长度单位无效。');
  const orientation = new THREE.Group(), root = new THREE.Group(); orientation.add(root);
  const geometries = [], materialList = [];
  try {
    for (const entry of snapshot.meshes) {
      if (!(entry.positions instanceof Float64Array) || entry.positions.length < 9 || entry.positions.length % 3 || entry.positions.some(value => !Number.isFinite(value))) throw new Error('完整位置数组无效。');
      if (entry.indices !== null && (!(entry.indices instanceof Uint32Array) || entry.indices.length % 3)) throw new Error('完整面索引无效。');
      if (!Array.isArray(entry.matrix) || entry.matrix.length !== 16 || entry.matrix.some(value => !Number.isFinite(value))) throw new Error('来源网格变换无效。');
      if (!Array.isArray(entry.materials) || !entry.materials.length || !Array.isArray(entry.groups)) throw new Error('来源材质分组无效。');
      const geometry = new THREE.BufferGeometry(); geometries.push(geometry);
      geometry.setAttribute('position', new THREE.BufferAttribute(entry.positions, 3));
      if(entry.colors!==null&&entry.colors!==undefined){
        if(!(entry.colors instanceof Float64Array)||![3,4].includes(entry.colorItemSize)||entry.colors.length!==entry.positions.length/3*entry.colorItemSize||entry.colors.some(value=>!Number.isFinite(value)))throw new Error('完整顶点颜色数组无效。');
        geometry.setAttribute('color',new THREE.BufferAttribute(entry.colors,entry.colorItemSize));
      }
      if (entry.indices) geometry.setIndex(new THREE.BufferAttribute(entry.indices, 1));
      for (const group of entry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      const materials = entry.materials.map(fact => {
        if (!/^#[\da-f]{6}$/i.test(fact.color)) throw new Error('来源基础颜色无效。');
        const material = new THREE.MeshStandardMaterial({ color: fact.color }); materialList.push(material);
        if(fact.linearColor){
          if(!Array.isArray(fact.linearColor)||fact.linearColor.length!==3||fact.linearColor.some(value=>!Number.isFinite(value)))throw new Error('来源基础线性颜色无效。');
          material.color.setRGB(...fact.linearColor,THREE.LinearSRGBColorSpace);
        }
        if (Number.isInteger(fact.toolIndex)) material.userData.toolIndex = fact.toolIndex;
        material.map = fact.hasTexture ? true : null; material.vertexColors = Boolean(fact.hasVertexColors);
        return material;
      });
      let mesh;
      const sourceMaterial = entry.materialArray ? materials : materials[0];
      if (entry.instances !== null) {
        if (!(entry.instances instanceof Float64Array) || entry.instances.length % 16 || entry.instances.length < 16 || entry.instances.length > 4096 * 16) throw new Error('来源实例变换无效。');
        mesh = new THREE.InstancedMesh(geometry, sourceMaterial, entry.instances.length / 16);
        const matrix = new THREE.Matrix4();
        for (let instance = 0; instance < mesh.count; instance++) { matrix.fromArray(entry.instances, instance * 16); mesh.setMatrixAt(instance, matrix); }
      } else mesh = new THREE.Mesh(geometry, sourceMaterial);
      mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(entry.matrix); root.add(mesh);
    }
    return createSliceSource({ orientation, metadata: snapshot.metadata, options: snapshot.options }, { preset, ...snapshot.limits });
  } finally { geometries.forEach(geometry => geometry.dispose()); materialList.forEach(material => material.dispose()); }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') self.onmessage = ({ data }) => {
  try {
    self.postMessage({ phase: 'generating' });
    const source = buildSliceSourceFromSnapshot(data.snapshot, { preset: data.preset });
    self.postMessage({ phase: 'complete', source });
  } catch (error) { self.postMessage({ phase: 'error', message: error.message }); }
};
