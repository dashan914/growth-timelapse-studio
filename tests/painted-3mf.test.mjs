import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFDMSurfaceProfile } from '../src/fdm-surface.js';
import fs from 'node:fs';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { decodePaintedTriangle, loadPaintedThreeMF, parseSlicerSettings } from '../src/painted-3mf.js';

const triangle = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
const palette = ['#F0E8D6', '#23599C', '#C89E59', '#101B2A'];
const mesh = paint => `<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="2" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" ${paint ? `paint_color="${paint}"` : ''}/></triangles></mesh>`;
const model = (resources, build, extra = '') => `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">${extra}<resources>${resources}</resources><build>${build}</build></model>`;
function archive(files, { project = { filament_colour: palette }, config = '<config/>' } = {}) {
  return zipSync(Object.fromEntries(Object.entries({
    '_rels/.rels': '<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>',
    ...files,
    'Metadata/project_settings.config': JSON.stringify(project),
    'Metadata/model_settings.config': config,
  }).map(([name, value]) => [name, strToU8(value)])));
}
const meshList = root => { const result = []; root.traverse(object => { if (object.isMesh) result.push(object); }); return result; };

test('official slicer hex states read from the right; first four exact filament identities', () => {
  for (const [encoded, state] of [['4', 1], ['8', 2], ['0C', 3], ['1C', 4], ['0FC', 18], ['4FC', 22], ['0FFC', 33]]) {
    assert.deepEqual(decodePaintedTriangle(encoded, triangle), [{ vertices: triangle, state }]);
  }
  assert.deepEqual(decodePaintedTriangle('', triangle), [{ vertices: triangle, state: 0 }]);
});

test('Orca final filament state and Bambu continuation chains follow the writer dialect', async () => {
  assert.equal(decodePaintedTriangle('FFC', triangle, { extendedStates: 'orca' })[0].state, 33);
  const colors = Array.from({ length: 33 }, (_, index) => `#${index.toString(16).padStart(6, '0')}`);
  const text = model(`<object id="1" type="model">${mesh('FFC')}</object>`, '<item objectid="1"/>', '<metadata name="Application">OrcaSlicer-2.4</metadata>');
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': text }, { project: { filament_colour: colors } }));
  assert.equal(meshList(result.root)[0].geometry.groups[0].materialIndex, 32);
});

test('three-side subdivisions preserve the four exact color regions and reverse child serialization', () => {
  const result = decodePaintedTriangle('480C1C3', triangle);
  assert.deepEqual(result, [
    { vertices: [[1, 0, 0], [1, 1, 0], [0, 1, 0]], state: 4 },
    { vertices: [[1, 1, 0], [0, 2, 0], [0, 1, 0]], state: 3 },
    { vertices: [[1, 0, 0], [2, 0, 0], [1, 1, 0]], state: 2 },
    { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], state: 1 },
  ]);
});

test('one-side and two-side painting split the side opposite the special vertex', () => {
  const one = decodePaintedTriangle('481', triangle);
  assert.deepEqual(one, [
    { vertices: [[1, 1, 0], [0, 2, 0], [0, 0, 0]], state: 2 },
    { vertices: [[0, 0, 0], [2, 0, 0], [1, 1, 0]], state: 1 },
  ]);
  assert.deepEqual(decodePaintedTriangle('485', triangle)[1].vertices, [[2, 0, 0], [0, 2, 0], [0, 1, 0]]);
  assert.deepEqual(decodePaintedTriangle('489', triangle)[1].vertices, [[0, 2, 0], [0, 0, 0], [1, 0, 0]]);
  const two = decodePaintedTriangle('480C2', triangle);
  assert.equal(two.length, 3);
  assert.deepEqual(two[0], { vertices: [[2, 0, 0], [0, 2, 0], [0, 1, 0]], state: 3 });
  assert.deepEqual(two[2], { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], state: 1 });
});

test('nested painted subdivisions conserve the original triangle area', () => {
  // Child 1 of an opposite-vertex-0 split is split again into two leaves.
  const leaves = decodePaintedTriangle('44811', triangle);
  const area = leaves.reduce((sum, { vertices: [a, b, c] }) => sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);
  assert.equal(leaves.length, 3);
  assert.equal(area, 2);
});

test('malformed, truncated, trailing and excessive paint data reject instead of losing color', () => {
  for (const bad of ['Z', 'C', 'FC', '4811', '84', '48D', '480C1CF']) assert.throws(() => decodePaintedTriangle(bad, triangle));
  assert.throws(() => decodePaintedTriangle('480C1C3', triangle, { maxNodes: 2 }), /复杂|有效/);
});

test('object default extruder and part overrides remain distinct', () => {
  const config = '<config><object id="15"><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="name" value="蓝屋顶 &amp; 金边"/><metadata key="extruder" value="2"/></part></object></config>';
  const settings = parseSlicerSettings(JSON.stringify({ filament_colour: palette }), config);
  assert.equal(settings.objects.get('15').extruder, '1');
  assert.equal(settings.objects.get('15').parts.get('1').extruder, '2');
  assert.equal(settings.objects.get('15').parts.get('1').name, '蓝屋顶 & 金边');
  assert.deepEqual(settings.colors, palette.map(color => color.toLowerCase()));
});

test('painted project loads exact solid materials with editable filament indexes', async () => {
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<object id="1" type="model">${mesh('480C1C3')}</object>`, '<item objectid="1"/>') }));
  assert.equal(result.recognized, true);
  assert.equal(result.colorSupport, 'painted');
  assert.equal(result.stats.renderedFaces, 4);
  const [object] = meshList(result.root);
  assert.equal(object.geometry.index.count, 12);
  assert.equal(object.geometry.groups.length, 4);
  assert.deepEqual(object.material.map(material => `#${material.color.getHexString()}`), palette.map(color => color.toLowerCase()));
  assert.deepEqual(object.material.map(material => material.userData.toolIndex), [0, 1, 2, 3]);
  assert.ok(object.material.every(material => material.userData.fdmProfile === 'pla' && material.roughness === resolveFDMSurfaceProfile('pla').roughness && material.metalness === 0), 'unspecified filament finish uses explicit nonmetallic PLA fallback');
  assert.equal(result.layerHeightMm, 0.16);
  assert.equal(result.lineWidthMm, 0.42);
  assert.equal(result.surfaceSettingsInferred.layerHeight, true);
});

test('cross-file production components apply each transform once, including millimeter conversion', async () => {
  const root = model('<object id="15" type="model"><components><component objectid="1" p:path="/3D/Objects/part.model" transform="1 0 0 0 1 0 0 0 1 10 20 30"/></components></object>', '<item objectid="15" transform="1 0 0 0 1 0 0 0 1 100 200 300"/>');
  const part = model(`<object id="1" type="model">${mesh('8')}</object>`, '').replace('unit="millimeter"', 'unit="centimeter"');
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': root, '3D/Objects/part.model': part }));
  result.root.updateMatrixWorld(true);
  const [object] = meshList(result.root);
  const position = new THREE.Vector3().fromBufferAttribute(object.geometry.attributes.position, 1).applyMatrix4(object.matrixWorld);
  assert.deepEqual(position.toArray(), [130, 220, 330]);
  assert.equal(object.material[1].userData.toolIndex, 1);
});

test('unpainted faces inherit part extruder assignment; obsolete metadata matrix is not applied', async () => {
  const config = '<config><object id="15"><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="extruder" value="2"/><metadata key="matrix" value="1 0 0 999 0 1 0 999 0 0 1 999 0 0 0 1"/></part></object></config>';
  const root = model(`<object id="1" type="model">${mesh('')}</object><object id="15" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 3 4 5"/></components></object>`, '<item objectid="15"/>');
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': root }, { config }));
  const [object] = meshList(result.root);
  assert.equal(result.colorSupport, 'extruders');
  assert.equal(object.geometry.groups[0].materialIndex, 1);
  assert.deepEqual(new THREE.Box3().setFromObject(result.root).min.toArray(), [3, 4, 5]);
});

test('legacy flattened mesh volume ranges choose each part extruder', async () => {
  const geometry = mesh('').replace('</triangles>', '<triangle v1="0" v2="1" v3="2"/></triangles>');
  const config = '<config><object id="1"><metadata key="extruder" value="1"/><volume firstid="0" lastid="0"><metadata key="extruder" value="2"/></volume><volume firstid="1" lastid="1"><metadata key="extruder" value="3"/></volume></object></config>';
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<object id="1" type="model">${geometry}</object>`, '<item objectid="1"/>') }, { config }));
  assert.deepEqual(meshList(result.root)[0].geometry.groups.map(group => group.materialIndex), [1, 2]);
});

test('support and parameter modifiers are excluded, automatic support settings do not invent support geometry', async () => {
  const config = '<config><object id="15"><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"/><part id="2" subtype="support_enforcer"/><part id="3" subtype="modifier_part"/></object></config>';
  const objects = [1, 2, 3].map(id => `<object id="${id}" type="model">${mesh('4')}</object>`).join('');
  const group = '<object id="15" type="model"><components><component objectid="1"/><component objectid="2"/><component objectid="3"/></components></object>';
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(objects + group, '<item objectid="15"/>') }, { config, project: { filament_colour: palette, enable_support: '1', support_type: 'tree(auto)' } }));
  assert.equal(meshList(result.root).length, 1);
  assert.equal(result.supportsAvailable, false);
  assert.equal(result.supportEnabled, true);
  assert.match(result.warnings.join(''), /未包含生成后的支撑几何/);
});

test('negative volumes reject uncut completed geometry in painted and standard-material projects', async () => {
  const objects = [1, 2].map(id => `<object id="${id}" type="model">${mesh('')}</object>`).join('');
  const group = '<object id="15" type="model"><components><component objectid="1"/><component objectid="2"/></components></object>';
  for (const colored of [false, true]) {
    const config = `<config><object id="15">${colored?'<metadata key="extruder" value="1"/>':''}<part id="1" subtype="normal_part"/><part id="2" subtype="negative_part"/></object></config>`;
    const bytes=archive({ '3D/3dmodel.model': model(objects + group, '<item objectid="15"/>') }, { config, project: { filament_colour: palette } });
    const before=bytes.slice();
    await assert.rejects(loadPaintedThreeMF(bytes), /减料体.*布尔减料/);
    assert.deepEqual(bytes,before);
  }
  const config = '<config><object id="1"><volume firstid="0" lastid="0"><metadata key="volume_type" value="NegativeVolume"/></volume></object></config>';
  await assert.rejects(loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(objects, '<item objectid="1"/>') }, { config })), /减料体/);
});

test('explicit 3MF support objects are identified for the show-supports control', async () => {
  const result = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<object id="1" type="support">${mesh('4')}</object>`, '<item objectid="1"/>') }, { project: { filament_colour: palette, enable_support: '1' } }));
  assert.equal(result.supportsAvailable, true);
  assert.equal(meshList(result.root)[0].userData.isSupport, true);
  assert.deepEqual(result.warnings, []);
});

test('native standard-color 3MF uses native loader fallback and invalid proprietary colors fail clearly', async () => {
  const native = await loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<basematerials id="2"><base displaycolor="#FF0000"/></basematerials><object id="1" type="model">${mesh('')}</object>`, '<item objectid="1"/>') }));
  assert.equal(native.root, null);
  assert.equal(native.recognized, false);
  await assert.rejects(loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<object id="1" type="model">${mesh('1C')}</object>`, '<item objectid="1"/>') }, { project: { filament_colour: ['#FF0000'] } })), /没有保存对应颜色/);
  await assert.rejects(loadPaintedThreeMF(archive({ '3D/3dmodel.model': model(`<object id="1" type="model">${mesh('4')}</object>`, '<item objectid="1"/>') }, { project: {} })), /没有保存耗材颜色/);
});

test('actual user archive retains all 1.54 million faces and the four saved paint colors', { skip: !process.env.GROWTH_TEST_3MF }, async () => {
  const result = await loadPaintedThreeMF(fs.readFileSync(process.env.GROWTH_TEST_3MF));
  assert.equal(result.stats.sourceFaces, 1541408);
  assert.equal(result.stats.paintedFaces, 1541408);
  assert.equal(result.stats.renderedFaces, 1541408);
  const counts = new Map();
  for (const object of meshList(result.root)) for (const group of object.geometry.groups) counts.set(group.materialIndex, (counts.get(group.materialIndex) ?? 0) + group.count / 3);
  assert.deepEqual([...counts].sort((a, b) => a[0] - b[0]), [[0, 118361], [1, 865954], [2, 539658], [3, 17435]]);
  assert.equal(meshList(result.root).length, 14);
  assert.equal(result.supportsAvailable, false);
  assert.equal(result.layerHeightMm, 0.12);
  assert.equal(result.firstLayerHeightMm, 0.25);
  assert.equal(result.lineWidthMm, 0.42);
  assert.deepEqual(result.surfaceSettingsInferred, { layerHeight: false, firstLayerHeight: false, lineWidth: false });
  assert.ok(result.materialProfiles.every(item => item.type === 'PLA' && item.profile === 'pla' && !item.inferred));
});
