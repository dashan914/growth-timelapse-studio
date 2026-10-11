import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parsePrintLayerGCode, PRINTER_MM_TO_THREE_MM, PRINT_FEATURE } from '../src/print-layer.js';
import { PrintLayerRenderer, IndexedSupportRenderer, buildPrintLayerPacket, printLayerProgressState, validatePrintLayerMapping, printLayerPacketTransferables, createStadiumGeometry, printBeadRatio, installStadiumExtrusion } from '../src/print-layer-renderer.js';
import { GrowthStudio } from '../src/studio.js';

const fixture = `; filament_colour = #f0e8d6;#23599c;#c89e59
; sparse_infill_density = 15%
; sparse_infill_pattern = grid
; wall_loops = 2
G21
G90
M82
G0 X10 Y10 Z0.25
;TYPE:Outer wall
;WIDTH:0.42
;HEIGHT:0.25
G1 X20 Y10 E1
G1 X20 Y20 E2
G1 X10 Y20 E3
G1 X10 Y10 E4
;TYPE:Inner wall
;WIDTH:0.45
G0 X11 Y11
G1 X19 Y11 E5
G1 X19 Y19 E6
G1 X11 Y19 E7
G1 X11 Y11 E8
T1
;TYPE:Internal infill
G0 X12 Y12
G1 X18 Y12 E9
G0 X12 Y18
G1 X18 Y18 E10
G0 X10 Y10 Z0.37
;TYPE:Support
;HEIGHT:0.12
G1 X15 Y15 E11
T2
;TYPE:Top surface
;WIDTH:0.42
G0 X12 Y12
G1 X18 Y12 E12
G0 X12 Y13
G1 X18 Y13 E13
G0 X12 Y12 Z0.61
T1
;TYPE:Internal infill
;HEIGHT:0.24
;WIDTH:0.45
G1 X18 Y18 E14
`;

const hash = array => createHash('sha256').update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
const axis = () => new THREE.Matrix4().fromArray(PRINTER_MM_TO_THREE_MM);

test('layer packets contain exactly source wall loops, sparse paths, physical sections and each tool color', () => {
  const parsed = parsePrintLayerGCode(fixture, { includeAuxiliary: true });
  const hashes = Object.fromEntries(['positions', 'tools', 'widths', 'heights', 'features', 'layers', 'layerSegments'].map(key => [key, hash(parsed[key])]));
  const mapping = axis().multiply(new THREE.Matrix4().makeTranslation(-100, -50, 0));
  const packet = buildPrintLayerPacket(parsed, { layerIndex: 0, historyLayers: 1, printerToSource: mapping });
  assert.equal(packet.instanceCount, 10);
  assert.deepEqual(packet.roleCounts, { outerWall: 4, innerWall: 4, sparseInfill: 2 });
  assert.deepEqual(packet.palette.map(item => item.color), ['#f0e8d6', '#23599c', '#c89e59']);
  assert.deepEqual([...packet.colorIndices], [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  const matrix = new THREE.Matrix4().fromArray(packet.matrices);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [-85, .125, 40], 'explicit relocation is retained rather than fitted to the model bbox');
  assert.ok(matrix.determinant() > 0, 'source basis is made right-handed without changing a symmetric bead');
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() - .42) < 1e-6);
  assert.equal(new THREE.Vector3().setFromMatrixColumn(matrix, 1).length(), 10);
  assert.equal(new THREE.Vector3().setFromMatrixColumn(matrix, 2).length(), .25);
  assert.deepEqual([...packet.positions.slice(0, 6)], [10, 10, .25, 20, 10, .25]);
  assert.ok(packet.crossSection.approximate, 'deposition cross-section is honestly distinct from exact centerlines');
  assert.equal(packet.features[8], PRINT_FEATURE.sparseInfill);
  for (const [key, value] of Object.entries(hashes)) assert.equal(hash(parsed[key]), value, `source ${key} unchanged`);
  const transfer = printLayerPacketTransferables(packet);
  assert.equal(new Set(transfer).size, transfer.length);
  assert.ok(transfer.every(buffer => buffer instanceof ArrayBuffer));
});

test('history uses actual deposited Z and excludes auxiliary structures unless explicitly enabled', () => {
  const parsed = parsePrintLayerGCode(fixture, { includeAuxiliary: true });
  assert.deepEqual([...parsed.layerHeights], [.25, .37, .61]);
  assert.deepEqual(printLayerProgressState(parsed, 0), { progress: 0, visibleLayerCount: 0, layerIndex: -1, heightMm: null, empty: true, complete: false });
  assert.equal(printLayerProgressState(parsed, 1 / 3).heightMm, .25);
  assert.equal(printLayerProgressState(parsed, 2 / 3).heightMm, .37);
  const current = buildPrintLayerPacket(parsed, { layerIndex: 1, historyLayers: 1, printerToSource: axis() });
  assert.equal(current.instanceCount, 2);
  assert.deepEqual([...current.tools], [2, 2]);
  const history = buildPrintLayerPacket(parsed, { layerIndex: 1, historyLayers: 2, includeSupport: true, printerToSource: axis() });
  assert.equal(history.instanceCount, 13);
  assert.equal(history.roleCounts.support, 1);
  assert.equal(history.roleCounts.outerWall, 4);
  assert.equal(history.roleCounts.innerWall, 4);
  assert.deepEqual([...history.layers], Array(10).fill(0).concat([1, 1, 1]));
  const last = buildPrintLayerPacket(parsed, { layerIndex: 2, historyLayers: 1, printerToSource: axis() });
  assert.equal(last.instanceCount, 1);
  assert.ok(Math.abs(last.heights[0] - .24) < 1e-6);
  assert.equal(last.heightMm, .61);
});

test('real layer renderer uses continuous extruded meshes, caches a layer, honors colors/supports and retains full endpoint behavior', () => {
  const parsed = parsePrintLayerGCode(fixture, { includeAuxiliary: true });
  const renderer = new PrintLayerRenderer(parsed, { printerToSource: axis() });
  assert.equal(renderer.update(0).empty, true);
  assert.equal(renderer.root.visible, false);
  const first = renderer.update(1 / 3);
  assert.equal(first.instanceCount, 10);
  assert.equal(renderer.root.visible, true);
  const white = renderer.meshes.get(0), blue = renderer.meshes.get(1);
  assert.ok(white.isInstancedMesh && blue.isInstancedMesh);
  assert.equal(white.geometry.userData.printCrossSection.shape, 'stadium-with-elliptical-fallback');
  assert.ok(white.geometry.userData.printCrossSection.closed);
  assert.equal(white.count, 8); assert.equal(blue.count, 2);
  assert.equal(blue.material.color.getHexString(), '23599c');
  assert.ok(renderer.root.userData.growthTransient && white.userData.growthTransient);
  const packet = renderer.packet;
  renderer.update(.34);
  assert.equal(renderer.packet, packet, 'same deposited layer reuses geometry rather than scanning all source paths');
  renderer.update(2 / 3, { includeSupport: true, toolColors: { 2: '#ff0000' }, surfacePreset: 'silk' });
  assert.equal(renderer.packet.instanceCount, 13);
  assert.equal(renderer.meshes.get(2).material.color.getHexString(), 'ff0000');
  assert.equal(renderer.meshes.get(2).material.metalness, 0);
  renderer.update(2 / 3, { includeSupport: false });
  assert.equal(renderer.packet.instanceCount, 12);
  const beforeState = renderer.state, beforePacket = renderer.packet;
  const detached = renderer.exportPacket({ layerIndex: 2, historyLayers: 1 });
  assert.equal(detached.instanceCount, 1);
  assert.equal(renderer.state, beforeState); assert.equal(renderer.packet, beforePacket);
  renderer.update(1);
  assert.equal(renderer.root.visible, false, 'complete frame is the original complete CAD geometry');
  assert.equal(renderer.state.complete, true);
  renderer.dispose();
  assert.equal(renderer.root.children.length, 0);
});

function studioFixture() {
  const studio = Object.create(GrowthStudio.prototype);
  studio.options = { progress: 0, preserveMaterials: true, color: '#b7bec8', modelScale: 1, toolColors: {}, showSupports: false, surfacePreset: 'auto', surfaceDetail: .6 };
  studio.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 8);
  studio.layerUniforms = { enabled: { value: 1 }, count: { value: 240 }, min: { value: 0 }, max: { value: 8 } };
  studio.scene = new THREE.Scene(); studio.modelGroup = new THREE.Group(); studio.scene.add(studio.modelGroup);
  studio._sourceMaterials = new Map(); studio._retainedMaterials = new Set();
  studio.cap = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial());
  studio.floor = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  studio.keyLight = { shadow: {} }; studio._bounds = new THREE.Box3();
  studio._turnRadians = 0;
  studio.setOptions = () => {}; studio.resetCamera = () => {};
  studio._drawScene = () => {}; studio._updateLightPosition = () => {}; studio._updateShadowHelper = () => {};
  const source = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20).translate(15, 5, -15), new THREE.MeshStandardMaterial({ color: '#f0e8d6' }));
  studio._adopt(source, 'source.3mf', '3mf', { mode: 'mesh', materialColors: [{ tool: 0, color: '#f0e8d6' }, { tool: 1, color: '#23599c' }, { tool: 2, color: '#c89e59' }] });
  return { studio, source };
}

test('studio retains every source face/color/buffer and actual mapped clipping follows the user pose without synthetic caps', async () => {
  const { studio, source } = studioFixture();
  const geometry = source.geometry;
  const original = Object.fromEntries(['position', 'normal'].map(key => [key, hash(geometry.attributes[key].array)]));
  const index = hash(geometry.index.array), material = source.material;
  await studio.loadPrintGCode(fixture, { printerToSource: PRINTER_MM_TO_THREE_MM, sourceName: 'test-slice.gcode' });
  assert.equal(studio.metadata.surfaceTopMode, 'sliced-gcode');
  assert.equal(studio.metadata.printLayer.layers, 3);
  assert.equal(studio.metadata.sliceSettings.wallLoops, 2);
  assert.equal(studio.metadata.sliceSettings.sparseInfillDensityPercent, 15);
  assert.equal(studio.metadata.sliceSettings.sparseInfillPattern, 'grid');
  studio.options.modelRotationZ = .35; studio.options.modelOffsetX = .4;
  studio.render(2 / 3);
  assert.equal(studio.metadata.printLayer.currentHeightMm, .37);
  const printerToWorld = studio.orientation.matrixWorld.clone().multiply(axis());
  const below = new THREE.Vector3(15, 15, .36).applyMatrix4(printerToWorld);
  const above = new THREE.Vector3(15, 15, .38).applyMatrix4(printerToWorld);
  assert.ok(studio.clipPlane.distanceToPoint(below) > 0);
  assert.ok(studio.clipPlane.distanceToPoint(above) < 0);
  assert.ok(Math.abs(studio.clipPlane.normal.x) > .1, 'clipping follows print direction after model rotation rather than the world horizontal');
  assert.equal(studio.cap.visible, false);
  assert.ok(studio._stencils.every(object => !object.visible));
  assert.ok(studio._partCaps.every(object => !object.visible));
  assert.equal(source.geometry, geometry); assert.equal(source.material, material);
  assert.equal(hash(geometry.index.array), index);
  for (const [key, value] of Object.entries(original)) assert.equal(hash(geometry.attributes[key].array), value);
  assert.equal(studio.metadata.triangles, 12);
  assert.equal(source.material.color.getHexString(), 'f0e8d6');
  const cacheBefore = studio.orientation.matrixWorld.elements.slice();
  const data = studio.getPrintLayerData(), packet = studio.getPrintLayerPacket({ layerIndex: 0, historyLayers: 1 });
  assert.deepEqual([...data.sourceToWorld], [...packet.sourceToWorld]);
  assert.deepEqual(studio.orientation.matrixWorld.elements, cacheBefore, 'detached packet read leaves live matrix caches untouched');
  assert.equal(packet.instanceCount, 10);
  studio.render(1);
  assert.equal(studio.modelGroup.visible, true);
  assert.equal(studio._printLayers.root.visible, false);
  assert.ok(studio.clipPlane.distanceToPoint(new THREE.Vector3(1e5, 1e5, 1e5)) > 0, 'completed CAD is fully unclipped');
  studio.render(0); assert.equal(studio.modelGroup.visible, false);
});

test('invalid mapping, missing colors or bad data fail atomically and never restore fake solid caps', async () => {
  assert.throws(() => validatePrintLayerMapping(), /明确/);
  assert.throws(() => validatePrintLayerMapping(new THREE.Matrix4().makeScale(0, 1, 1)), /不可逆/);
  const { studio } = studioFixture();
  studio.render(.5); assert.equal(studio.cap.visible, false);
  await assert.rejects(studio.loadPrintGCode(fixture), /明确/);
  assert.equal(studio._printLayers, null);
  await studio.loadPrintGCode(fixture, { printerToSource: axis() });
  const current = studio._printLayers, source = studio._meshes[0];
  const parsed = parsePrintLayerGCode(fixture); parsed.usedTools.push(8);
  await assert.rejects(studio.loadPrintGCode(parsed, { printerToSource: axis() }), /缺少耗材 9/);
  assert.equal(studio._printLayers, current);
  assert.equal(studio._meshes[0], source);
  const incomplete = { ...parsePrintLayerGCode(fixture), positions: new Float32Array(6) };
  await assert.rejects(studio.loadPrintGCode(incomplete, { printerToSource: axis() }), /数据长度/);
  assert.equal(studio._printLayers, current);
  assert.equal(studio.metadata.surfaceTopMode, 'sliced-gcode');
  studio.loadDemo();
  assert.equal(studio._printLayers, null);
  assert.equal(current.root.parent, null);
  assert.equal(studio.metadata.surfaceTopMode, 'slice-required');
});

test('primary G-code import accepts complete worker data, typed layer ordering and exact current beads without legacy limits', async () => {
  const { studio } = studioFixture();
  const parsed = parsePrintLayerGCode(fixture, { includeSupport: true });
  const file = new File(['not parsed again'], 'complete.gcode');
  file.text = async () => { throw new Error('worker source must not be reparsed on the UI thread'); };
  await studio.loadFiles([file], { parsedPrintGCode: parsed });
  assert.equal(studio.metadata.mode, 'gcode');
  assert.equal(studio.metadata.sourcePathsComplete, true);
  assert.equal(studio.metadata.segments, 14);
  assert.equal(studio.metadata.displayedPathSegments, 13);
  assert.ok(studio._gcodeOrder instanceof Uint32Array);
  assert.equal(studio._gcode, parsed);
  assert.ok(studio.metadata.supportsAvailable);
  studio.render(1 / 3);
  assert.equal(studio.modelGroup.visible, true, 'current exact beads show even when no older path layer is visible');
  assert.equal(studio._printLayers.root.visible, true);
  assert.equal(studio._meshes[0].geometry.instanceCount, 0);
  studio.render(1);
  assert.equal(studio._printLayers.root.visible, true, 'path-only source keeps real final-layer beads because no CAD shell exists');
  assert.equal(studio._printLayers.packet.instanceCount, 13);
  studio.options.toolColors = { 1: '#eeee00' };
  const data = studio.getPrintLayerData();
  assert.equal(data.toolColors[1], '#eeee00');
  assert.equal(data.parsed.toolColors[1], '#23599c', 'manual color choice does not overwrite source palette');
  studio.options.showSupports = true;
  studio._prepareGCode(); studio.render(2 / 3);
  assert.equal(studio.metadata.displayedPathSegments, 14);
  assert.equal(studio._printLayers.packet.instanceCount, 13);
  studio.options.showSupports = false;
  studio._prepareGCode(); studio.render(2 / 3);
  assert.equal(studio._printLayers.packet.instanceCount, 12);
  const current = studio._meshes[0];
  await assert.rejects(studio.loadFiles([file], { parsedPrintGCode: { ...parsed, positions: new Float32Array(6) } }), /数据长度/);
  assert.equal(studio._meshes[0], current, 'bad worker payload cannot replace the previous source');
});

test('complete indexed supports keep exact tools, widths, every path and final visibility, with continuous width-aware rasterization', async () => {
  const parsed = parsePrintLayerGCode(fixture, { includeSupport: true });
  const before = hash(parsed.positions);
  const support = new IndexedSupportRenderer(parsed, { printerToSource: axis() });
  assert.equal(support.segmentCount, 1);
  assert.equal(support.records.get(1).sourceIds[0], 10);
  assert.equal(support.records.get(1).geometry.attributes.instancePrintWidth.getX(0), parsed.widths[10]);
  const record = support.records.get(1);
  const shader = { vertexShader: record.material.vertexShader, fragmentShader: record.material.fragmentShader };
  record.material.onBeforeCompile(shader, null);
  assert.match(shader.vertexShader, /attribute float instancePrintWidth/);
  assert.match(shader.vertexShader, /float hw = printLinewidth \* 0\.5/);
  assert.match(shader.fragmentShader, /len \/ vPrintLinewidth/);
  assert.equal(support.update(2 / 3, { historyLayers: 3 }).visibleSegments, 0, 'the current bead renderer owns nearby layers');
  assert.equal(support.update(1, { historyLayers: 3, widthScale: .04, toolColors: { 1: '#ff00ff' } }).visibleSegments, 1);
  assert.equal(support.root.visible, true, 'all already-printed support remains when complete CAD takes over');
  assert.equal(record.material.linewidth, .04);
  assert.equal(record.material.color.getHexString(), 'ff00ff');
  support.update(1, { showSupports: false }); assert.equal(support.root.visible, false);
  support.update(1, { supportDisplay: 'solid' });
  assert.equal(record.solidMaterial.color.getHexString(), parsed.toolColors[1].slice(1), 'solid support keeps its actual indexed filament color');
  assert.equal(record.material.color.getHexString(), parsed.toolColors[1].slice(1), 'display mode does not rewrite the filament palette');
  assert.equal(record.material.visible, false, 'entity mode cannot silently show camera-facing path lines');
  assert.equal(record.shadow.material, record.solidMaterial);
  assert.equal(record.shadow.userData.solidSupport, true);
  assert.ok(record.solidMaterial.isMeshStandardMaterial);
  assert.equal(record.solidMaterial.metalness, 0);
  assert.equal(record.shadow.geometry.userData.printCrossSection.closed, true);
  assert.equal(record.shadow.geometry.userData.printCrossSection.flatContact, true);
  assert.ok(support.radialSegments >= 8 && support.maximumCrossSectionErrorMm <= .02);
  const instance = new THREE.Matrix4(); record.shadow.getMatrixAt(0, instance);
  const segment = record.sourceIds[0], offset = segment * 6;
  assert.ok(instance.determinant() > 0);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(instance, 0).length() - parsed.widths[segment]) < 1e-6);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixColumn(instance, 2).length() - parsed.heights[segment]) < 1e-6);
  assert.ok(Math.abs(instance.elements[14] - ((parsed.positions[offset + 2] + parsed.positions[offset + 5]) / 2 - parsed.heights[segment] / 2)) < 1e-6);
  support.update(1, { supportDisplay: 'paths' });
  assert.equal(record.material.visible, true);
  assert.equal(record.shadow.material, record.shadowMaterial);
  assert.equal(record.shadow.userData.solidSupport, false);
  assert.equal(hash(parsed.positions), before);
  support.dispose();

  const { studio, source } = studioFixture();
  studio.options.showSupports = true;
  await studio.loadPrintGCode(parsed, { printerToSource: axis() });
  assert.equal(studio.metadata.supportSource, 'sliced-gcode-indexed');
  assert.equal(studio.metadata.supportSegments, 1);
  assert.equal(studio.metadata.supportTolerance, 0);
  assert.equal(studio._supportOverlay, null);
  studio.render(2 / 3);
  assert.equal(studio.metadata.visibleSupportSegments, 1);
  studio.render(1);
  assert.equal(studio._printLayers.root.visible, false);
  assert.equal(studio._indexedSupports.root.visible, true);
  assert.equal(studio.metadata.visibleSupportSegments, 1);
  assert.equal(source.geometry.index.count / 3, 12);
  studio.options.showSupports = false; studio.render(1);
  assert.equal(studio._indexedSupports.root.visible, false);
  const previous = studio._indexedSupports;
  await assert.rejects(studio.loadIndexedSupportData(parsed), /明确/);
  assert.equal(studio._indexedSupports, previous);
});

test('stadium roads have flat physical contact, rounded sides, correct transformed normals and explicit bridge/narrow fallback', () => {
  const geometry = createStadiumGeometry(16), width = .42, height = .12, ratio = printBeadRatio(width, height, PRINT_FEATURE.support);
  const positions = geometry.attributes.position, sides = geometry.attributes.beadCrossSide, normals = geometry.attributes.normal;
  const ringCount = (16 + 1) * 2;
  const section = [];
  for (let index = 0; index < ringCount; index++) {
    const x = width * (.5 * (1 - ratio) * sides.getX(index) + positions.getX(index) * ratio);
    const z = height * positions.getZ(index);
    section.push([x, z]);
  }
  const top = section.filter(([, z]) => Math.abs(z - height / 2) < 1e-8).map(([x]) => x);
  const bottom = section.filter(([, z]) => Math.abs(z + height / 2) < 1e-8).map(([x]) => x);
  assert.ok(Math.abs(Math.max(...top) - Math.min(...top) - (width - height)) < 1e-8);
  assert.ok(Math.abs(Math.max(...bottom) - Math.min(...bottom) - (width - height)) < 1e-8);
  // Vertically stacked layers share an entire line region, not one tangent point.
  assert.deepEqual(top.slice().sort((a,b) => a-b), bottom.slice().sort((a,b) => a-b));
  let twiceArea = 0;
  for (let index = 0; index < section.length; index++) {
    const a = section[index], b = section[(index + 1) % section.length]; twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const expectedArea = height * (width - height) + Math.PI * height * height / 4;
  assert.ok(Math.abs(Math.abs(twiceArea) / 2 - expectedArea) / expectedArea < .002, 'polygon display approaches actual ordinary FDM flow area');
  const index = 7;
  const actualNormal = new THREE.Vector3(normals.getX(index) / ratio / width, 0, normals.getZ(index) / height).normalize();
  const expectedNormal = new THREE.Vector3(normals.getX(index), 0, normals.getZ(index)).normalize();
  assert.ok(actualNormal.distanceTo(expectedNormal) < 1e-7, 'instance inverse scaling yields a circular side normal rather than an abnormal dark ellipse normal');
  assert.equal(printBeadRatio(.42, .12, PRINT_FEATURE.bridge), 1);
  assert.equal(printBeadRatio(.1, .2, PRINT_FEATURE.outerWall), 1);
  const shader = { vertexShader: '#include <beginnormal_vertex>\n#include <begin_vertex>', fragmentShader: '' };
  const material = installStadiumExtrusion(new THREE.MeshStandardMaterial()); material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /objectNormal.x \/= max\(instanceBeadRatio/);
  assert.match(shader.vertexShader, /0.5 \* \(1.0 - beadRatio\) \* beadCrossSide/);
  assert.equal(material.defaultAttributeValues.beadCrossEnabled[0], 0, 'non-bead CAD vertices remain untouched under generic analysis overrides');
});

test('actual user project parses all paths and conserves selected layer windows without simplification', { skip: !process.env.GROWTH_PRINT_GCODE }, async () => {
  const started = performance.now(), text = await readFile(process.env.GROWTH_PRINT_GCODE, 'utf8');
  const readMs = performance.now() - started, parseStart = performance.now();
  const parsed = parsePrintLayerGCode(text, { includeSupport: true });
  const parseMs = performance.now() - parseStart;
  assert.equal(parsed.layerHeights.length, 1579);
  assert.ok(parsed.segmentCount > 2_000_000);
  assert.deepEqual(parsed.toolColors.slice(0, 4), ['#f0e8d6', '#23599c', '#c89e59', '#101b2a']);
  assert.ok(parsed.featureCounts.outerWall > 0 && parsed.featureCounts.innerWall > 0 && parsed.featureCounts.sparseInfill > 0 && parsed.featureCounts.topSurface > 0);
  const windows = [];
  for (const layerIndex of [0, 25, 500, 789, 1200, 1578]) {
    const before = performance.now();
    const packet = buildPrintLayerPacket(parsed, { layerIndex, historyLayers: 3, includeSupport: true, printerToSource: axis() });
    assert.equal(packet.instanceCount, parsed.layerOffsets[layerIndex + 1] - parsed.layerOffsets[Math.max(0, layerIndex - 2)]);
    assert.equal(new Set(packet.segments).size, packet.instanceCount);
    for (let index = 0; index < packet.instanceCount; index++) {
      const segment = packet.segments[index];
      assert.deepEqual([...packet.positions.slice(index * 6, index * 6 + 6)], [...parsed.positions.slice(segment * 6, segment * 6 + 6)]);
      assert.equal(packet.tools[index], parsed.tools[segment]);
      assert.equal(packet.widths[index], parsed.widths[segment]);
      assert.equal(packet.heights[index], parsed.heights[segment]);
      assert.equal(packet.palette[packet.colorIndices[index]].color, parsed.toolColors[parsed.tools[segment]]);
    }
    windows.push({ layerIndex, heightMm: packet.heightMm, segments: packet.instanceCount, packetMs: performance.now() - before, roleCounts: packet.roleCounts });
  }
  const supportStart = performance.now();
  const support = new IndexedSupportRenderer(parsed, { printerToSource: axis() });
  const supportBuildMs = performance.now() - supportStart;
  const expectedSupports = (parsed.featureCounts.support || 0) + (parsed.featureCounts.supportInterface || 0);
  assert.equal(support.segmentCount, expectedSupports);
  assert.ok(expectedSupports > 2_000_000, 'actual full support source exceeds the old cap and must remain complete');
  assert.equal(support.update(1).visibleSegments, expectedSupports);
  let supportCount = 0;
  for (const [tool, record] of support.records) {
    supportCount += record.sourceIds.length;
    assert.equal(record.material.color.getHexString(), parsed.toolColors[tool].slice(1));
    let previousLayer = -1;
    for (let index = 0; index < record.sourceIds.length; index++) {
      const segment = record.sourceIds[index];
      assert.ok(parsed.features[segment] === PRINT_FEATURE.support || parsed.features[segment] === PRINT_FEATURE.supportInterface);
      assert.equal(record.widths[index], parsed.widths[segment]);
      assert.equal(parsed.tools[segment], tool);
      assert.ok(record.layers[index] >= previousLayer); previousLayer = record.layers[index];
    }
  }
  assert.equal(supportCount, expectedSupports);
  const report = { file: process.env.GROWTH_PRINT_GCODE, bytes: Buffer.byteLength(text), readMs, parseMs,
    segmentCount: parsed.segmentCount, layerCount: parsed.layerHeights.length, featureCounts: parsed.featureCounts,
    rawFeatureCounts: parsed.rawFeatureCounts, warnings: parsed.warnings, toolColors: parsed.toolColors,
    inferredWidthSegments: parsed.inferredWidthSegments, inferredHeightSegments: parsed.inferredHeightSegments,
    sampledArcMoves: parsed.sampledArcMoves, unknownExtrusionMoves: parsed.unknownExtrusionMoves, windows,
    supportBuildMs, supportSegments: expectedSupports, supportTools: [...support.records.keys()],
    supportRadialSegments: support.radialSegments, supportCrossSectionToleranceMm: support.crossSectionToleranceMm,
    supportCrossSectionErrorMm: support.maximumCrossSectionErrorMm, supportSurfaceTriangles: support.surfaceTriangles,
    memoryBytes: process.memoryUsage() };
  support.dispose();
  if (process.env.GROWTH_PRINT_REPORT) await writeFile(process.env.GROWTH_PRINT_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
});
