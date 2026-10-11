import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { withCreaseNormals } from '../src/crease-normals.js';
import { loadPaintedThreeMF } from '../src/painted-3mf.js';

function geometry(positions, indices) {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (indices) result.setIndex(indices);
  return result;
}
const at = (g, corner, name = 'normal') => new THREE.Vector3().fromBufferAttribute(g.getAttribute(name), g.index?.getX(corner) ?? corner);
const positionStream = g => Array.from({ length: g.index?.count ?? g.attributes.position.count }, (_, corner) => at(g, corner, 'position').toArray()).flat();
const closeVector = (actual, expected, epsilon = 1e-6) => assert.ok(actual.distanceTo(new THREE.Vector3(...expected)) < epsilon, `${actual.toArray()} differs from ${expected}`);

test('box and 90-degree step normals retain planar hard edges without changing triangle positions', () => {
  const cube = geometry([-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1], [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5]);
  const result = withCreaseNormals(cube);
  assert.equal(result.index.count, cube.index.count);
  assert.deepEqual(positionStream(result), positionStream(cube));
  assert.equal(result.attributes.position.count, 24);
  const expected = [[0,0,-1],[0,0,1],[0,-1,0],[0,1,0],[-1,0,0],[1,0,0]];
  for (let face = 0; face < 12; face++) for (let corner = 0; corner < 3; corner++) closeVector(at(result, face * 3 + corner), expected[Math.floor(face / 2)]);
  const step = geometry([0,0,0, 2,0,0, 0,1,0, 2,1,0, 0,1,1, 2,1,1], [0,1,2, 1,3,2, 2,3,4, 3,5,4]);
  const shadedStep = withCreaseNormals(step);
  assert.deepEqual(positionStream(shadedStep), positionStream(step));
  closeVector(at(shadedStep, 2), [0,0,1]);
  closeVector(at(shadedStep, 6), [0,-1,0]);
});

test('connected fine cylinder segments stay smooth with radial normals and no face loss', () => {
  const segments = 64, positions = [], indices = [];
  for (let y = 0; y < 2; y++) for (let segment = 0; segment < segments; segment++) {
    const angle = segment / segments * Math.PI * 2;
    positions.push(Math.cos(angle), y, Math.sin(angle));
  }
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.push(segment, segment + segments, next, next, segment + segments, next + segments);
  }
  const source = geometry(positions, indices), result = withCreaseNormals(source);
  assert.equal(result.attributes.position.count, source.attributes.position.count);
  assert.deepEqual(positionStream(result), positionStream(source));
  for (let corner = 0; corner < indices.length; corner++) {
    const id = indices[corner], angle = (id % segments) / segments * Math.PI * 2;
    closeVector(at(result, corner), [Math.cos(angle), 0, Math.sin(angle)], 2e-6);
  }
});

test('angle-weighted normals prevent a much larger wall face from overpowering a narrow ledge', () => {
  const source = geometry([0,0,0, 1,0,0, 0,100,0, 0,-1,1], [0,1,2, 1,0,3]);
  const result = withCreaseNormals(source);
  assert.equal(result.attributes.position.count, 4);
  const expected = [0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  closeVector(at(result, 0), expected);
  closeVector(at(result, 4), expected);
  assert.deepEqual(positionStream(result), positionStream(source));
});

test('coincident positions and disconnected point contacts are not welded or smoothed together', () => {
  const source = geometry([0,0,0, 1,0,0, 0,1,0, 0,0,0, 0,1,0, 0,0,1], [0,1,2, 3,4,5, 0,4,5]);
  const result = withCreaseNormals(source);
  closeVector(at(result, 0), [0,0,1]);
  closeVector(at(result, 3), [1,0,0]);
  closeVector(at(result, 6), [1,0,0]);
  assert.notEqual(result.index.getX(0), result.index.getX(6));
  assert.deepEqual(positionStream(result), positionStream(source));
});

test('zero-area faces survive with finite normals and cannot pollute a valid face', () => {
  const source = geometry([0,0,0, 1,0,0, 0,1,0], [0,1,2, 0,0,1]);
  source.addGroup(0, 3, 0); source.addGroup(3, 3, 1);
  const result = withCreaseNormals(source);
  assert.equal(result.index.count, 6);
  assert.deepEqual(positionStream(result), positionStream(source));
  assert.deepEqual(result.groups, source.groups);
  assert.ok([...result.attributes.normal.array].every(Number.isFinite));
  closeVector(at(result, 0), [0,0,1]);
});

test('all attributes, morph attributes, exact groups and draw range follow split vertices', () => {
  const source = geometry([0,0,0, 1,0,0, 0,1,0, 0,0,1], [0,1,2, 0,3,1]);
  const colors = new THREE.Uint8BufferAttribute([255,10,0, 0,20,255, 40,255,0, 99,0,255], 3, true);
  colors.setUsage(THREE.DynamicDrawUsage); colors.name = 'Original paint';
  source.setAttribute('color', colors);
  const uvData = new THREE.InterleavedBuffer(new Float32Array([9,0,0, 9,1,0, 9,0,1, 9,1,1]), 3);
  source.setAttribute('uv', new THREE.InterleavedBufferAttribute(uvData, 2, 1));
  source.morphAttributes.position = [new THREE.Float32BufferAttribute([1,2,3, 4,5,6, 7,8,9, 10,11,12], 3)];
  source.morphTargetsRelative = true;
  source.addGroup(0,3,2); source.addGroup(3,3,3);
  source.setDrawRange(3,3); source.computeBoundingBox(); source.computeBoundingSphere();
  source.userData.marker = 'retained';
  const result = withCreaseNormals(source);
  assert.deepEqual(positionStream(result), positionStream(source));
  assert.deepEqual(result.groups, source.groups);
  assert.deepEqual(result.drawRange, source.drawRange);
  assert.deepEqual(result.boundingBox, source.boundingBox);
  assert.deepEqual(result.boundingSphere, source.boundingSphere);
  assert.equal(result.userData.marker, 'retained');
  assert.equal(result.morphTargetsRelative, true);
  assert.equal(result.attributes.color.normalized, true);
  assert.equal(result.attributes.color.usage, THREE.DynamicDrawUsage);
  assert.equal(result.attributes.color.name, 'Original paint');
  for (let corner=0; corner<source.index.count; corner++) {
    const from=source.index.getX(corner), to=result.index.getX(corner);
    assert.deepEqual([...result.attributes.color.array.slice(to*3,to*3+3)], [...colors.array.slice(from*3,from*3+3)]);
    assert.equal(result.attributes.uv.getX(to), source.attributes.uv.getX(from));
    assert.equal(result.attributes.uv.getY(to), source.attributes.uv.getY(from));
    closeVector(new THREE.Vector3().fromBufferAttribute(result.morphAttributes.position[0],to), new THREE.Vector3().fromBufferAttribute(source.morphAttributes.position[0],from).toArray());
  }
  assert.equal(source.attributes.position.count, 4);
  assert.equal(source.getAttribute('normal'), undefined);
});

test('nonindexed triangles retain independent face shading and malformed indexes fail clearly', () => {
  const source = geometry([0,0,0, 1,0,0, 0,1,0]);
  const result = withCreaseNormals(source);
  assert.deepEqual(positionStream(result), positionStream(source));
  closeVector(at(result,0),[0,0,1]);
  assert.throws(()=>withCreaseNormals(source,NaN),/夹角/);
  assert.throws(()=>withCreaseNormals(geometry([0,0,0],[0,1,0])),/顶点/);
  assert.throws(()=>withCreaseNormals(geometry([0,0,0],[0])),/索引/);
});

test('actual 3MF keeps 1.54M faces/colors and fixes the front-left ivory ledge normal', { skip: !process.env.GROWTH_TEST_3MF }, async () => {
  const result = await loadPaintedThreeMF(fs.readFileSync(process.env.GROWTH_TEST_3MF));
  assert.equal(result.stats.sourceFaces,1541408); assert.equal(result.stats.renderedFaces,1541408);
  let annex;
  result.root.traverse(mesh=>{if(mesh.isMesh&&mesh.name.includes('front_left_annex'))annex=mesh;});
  assert.ok(annex);
  const counts = new Map();
  result.root.traverse(mesh=>{if(mesh.isMesh)for(const group of mesh.geometry.groups)counts.set(group.materialIndex,(counts.get(group.materialIndex)??0)+group.count/3);});
  assert.deepEqual([...counts].sort((a,b)=>a[0]-b[0]),[[0,118361],[1,865954],[2,539658],[3,17435]]);
  result.root.updateMatrixWorld(true);
  const g=annex.geometry, positions=g.attributes.position, center=new THREE.Vector3();
  let checked=0;
  for(let corner=0;corner<g.index.count;corner+=3){
    center.copy(at(g,corner,'position')).add(at(g,corner+1,'position')).add(at(g,corner+2,'position')).divideScalar(3).applyMatrix4(annex.matrixWorld);
    if(Math.abs(center.x-72.0017537)>0.0001||Math.abs(center.y-80.6296023)>0.0001||Math.abs(center.z-14.2800007)>0.0001)continue;
    for(let offset=0;offset<3;offset++)closeVector(at(g,corner+offset),[0,0,1]);
    checked++;
  }
  assert.equal(checked,1);
  assert.ok(positions.count < g.index.count, 'retains indexed reuse instead of expanding every corner');
});
