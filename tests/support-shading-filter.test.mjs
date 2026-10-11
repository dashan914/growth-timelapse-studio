import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {supportLayerFilterWeight,supportSemicircleDiffuseAverage,installSupportLayerFilter,installStadiumExtrusion,IndexedSupportRenderer} from '../src/print-layer-renderer.js';
import {parsePrintLayerGCode,PRINTER_MM_TO_THREE_MM} from '../src/print-layer.js';

const hash=array=>createHash('sha256').update(Buffer.from(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<=e,`${a} ≠ ${b}`);
function projectedQuadrature(a,b,N=50000){let sum=0,weight=0;for(let i=0;i<N;i++){const theta=-Math.PI/2+(i+.5)*Math.PI/N,w=Math.cos(theta);sum+=Math.max(0,a*Math.cos(theta)+b*Math.sin(theta))*w;weight+=w;}return sum/weight;}

test('analytic side diffuse preserves projected area average for positive, backlit and overhead directions',()=>{
 for(const [a,b] of [[1,0],[-1,0],[0,1],[0,-1],[.5,.5],[-.3,.95],[.8,-.6],[-.8,-.6],[.000001,1],[0,0]]) near(supportSemicircleDiffuseAverage(a,b),projectedQuadrature(a,b),1e-8);
 near(supportSemicircleDiffuseAverage(1,0),Math.PI/4);near(supportSemicircleDiffuseAverage(0,1),.25);assert.equal(supportSemicircleDiffuseAverage(-1,0),0);
 for(let i=0;i<128;i++){const angle=i*2*Math.PI/128;const value=supportSemicircleDiffuseAverage(Math.cos(angle),Math.sin(angle));assert.ok(value>=0&&value<=1);}
 assert.throws(()=>supportSemicircleDiffuseAverage(NaN,1),/有限/);
});

test('pixel footprint filters only unresolved real heights and remains off for caps/fallbacks',()=>{
 assert.equal(supportLayerFilterWeight(.12,.015),0,'8 pixels per layer retains its real bead normal');
 assert.equal(supportLayerFilterWeight(.12,.4),1,'0.3 pixel layer has unresolved phase');
 assert.equal(supportLayerFilterWeight(.12,.4,false),0);
 assert.equal(supportLayerFilterWeight(.24,.03),0);
 assert.equal(supportLayerFilterWeight(.12,.06),1,'full averaging at Nyquist');
 assert.ok(supportLayerFilterWeight(.12,.04)>0&&supportLayerFilterWeight(.12,.04)<1);
 near(supportLayerFilterWeight(.12,.04),supportLayerFilterWeight(.24,.08));
 assert.throws(()=>supportLayerFilterWeight(0,.1),/有效/);
});

test('unresolved phase-independent diffuse removes periodic Lambert sample beating without making every phase brighter',()=>{
 // Normal of a physically circular rounded side, parameterized by normalized
 // projected layer height z=sin(theta). All samples retain the same material.
 const normalAt=z=>[Math.sqrt(Math.max(0,1-z*z)),z];
 const light=[Math.cos(Math.PI/4),Math.sin(Math.PI/4)];
 const avg=supportSemicircleDiffuseAverage(...light);
 const aliases=[];for(let phase=0;phase<32;phase++){let sum=0;for(let pixel=0;pixel<64;pixel++){const turn=(pixel/.3+phase/32)%1,z=2*turn-1,n=normalAt(z);sum+=Math.max(0,n[0]*light[0]+n[1]*light[1]);}aliases.push(sum/64);}
 assert.ok(Math.max(...aliases)-Math.min(...aliases)>.02,'single-hit sampling depends on subpixel phase');
 assert.ok(aliases.some(v=>v>avg)&&aliases.some(v=>v<avg),'filter is area averaging rather than a brightness lift');
 near(avg,projectedQuadrature(...light),1e-8);
 const filtered=aliases.map(()=>avg);assert.equal(Math.max(...filtered)-Math.min(...filtered),0);
});

const sample=`; filament_colour = #f0e8d6;#101b2a
G21
G90
M82
G0 X0 Y0 Z0.25
;TYPE:Support
;WIDTH:0.42
;HEIGHT:0.25
G1 X20 Y0 E1
G0 X0 Y0 Z0.37
T1
;TYPE:Support
;HEIGHT:0.12
G1 X20 Y0 E2
G0 X0 Y0 Z0.49
T0
;TYPE:Support interface
G1 X20 Y0 E3
`;

test('candidate is opt-in and leaves every source/geometry/index/color/depth byte intact across updates',()=>{
 const data=parsePrintLayerGCode(sample,{includeSupport:true});
 const arrays=['positions','tools','features','widths','heights','strokes','layers','layerHeights','layerOffsets','layerSegments'];
 const sourceBefore=Object.fromEntries(arrays.map(k=>[k,hash(data[k])]));
 const renderer=new IndexedSupportRenderer(data,{printerToSource:new THREE.Matrix4().fromArray(PRINTER_MM_TO_THREE_MM)});
 const snapshots=new Map();for(const [tool,r]of renderer.records){snapshots.set(tool,{ids:hash(r.sourceIds),indices:hash(r.surfaceGeometry.index.array),position:hash(r.surfaceGeometry.attributes.position.array),normal:hash(r.surfaceGeometry.attributes.normal.array),matrix:hash(r.shadow.instanceMatrix.array),ratio:hash(r.surfaceGeometry.attributes.instanceBeadRatio.array),color:r.solidMaterial.color.getHexString(),depth:r.depthMaterial.onBeforeCompile.toString(),attributes:Object.keys(r.surfaceGeometry.attributes)});assert.equal(r.solidMaterial.userData.supportLayerFilter.enabled.value,0);}
 renderer.update(1,{supportNormalFilter:'analytic'});assert.equal(renderer.state.supportNormalFilter,'analytic');assert.equal(renderer.state.visibleSegments,3);
 for(const [tool,r]of renderer.records){const before=snapshots.get(tool);assert.equal(r.solidMaterial.userData.supportLayerFilter.enabled.value,1);for(const [key,array]of Object.entries({ids:r.sourceIds,indices:r.surfaceGeometry.index.array,position:r.surfaceGeometry.attributes.position.array,normal:r.surfaceGeometry.attributes.normal.array,matrix:r.shadow.instanceMatrix.array,ratio:r.surfaceGeometry.attributes.instanceBeadRatio.array}))assert.equal(hash(array),before[key],key);assert.equal(r.solidMaterial.color.getHexString(),before.color);assert.equal(r.depthMaterial.onBeforeCompile.toString(),before.depth);assert.deepEqual(Object.keys(r.surfaceGeometry.attributes),before.attributes,'no added per-path geometry buffers');}
 renderer.update(1,{supportNormalFilter:'none'});for(const r of renderer.records.values())assert.equal(r.solidMaterial.userData.supportLayerFilter.enabled.value,0);
 for(const key of arrays)assert.equal(hash(data[key]),sourceBefore[key]);
 renderer.dispose();
});

test('real standard shader retains resolved roughness AA and uses stable unresolved roughness without modifying source depth/color',()=>{
 const material=installSupportLayerFilter(installStadiumExtrusion(new THREE.MeshStandardMaterial()));
 const baseline={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
 material.onBeforeCompile(baseline,null);
 assert.equal(baseline.fragmentShader,THREE.ShaderLib.standard.fragmentShader,'default off has exact original fragment program');
 assert.doesNotMatch(baseline.vertexShader,/vSupportMacroNormal/,'default off adds no per-vertex filtering work');
 material.userData.supportLayerFilter.enabled.value=1;
 const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
 material.onBeforeCompile(shader,null);
 assert.equal(shader.uniforms.supportLayerFilterEnabled.value,1);
 const coordinate=shader.vertexShader.indexOf('vSupportLayerCoordinate = (instanceMatrix');
 const position=shader.vertexShader.indexOf('#include <begin_vertex>');assert.ok(coordinate>position,'deformed transformed position must exist before footprint assignment');
 assert.match(shader.vertexShader,/supportWidth >= supportHeight/);assert.match(shader.vertexShader,/abs\(objectNormal.y\) < 0.5/);
 assert.match(shader.fragmentShader,/step\(0.000001,supportMacroLength\)/,'flat tops with zero lateral normal remain exact');
 assert.match(shader.fragmentShader,/NUM_RECT_AREA_LIGHTS > 0 \|\| defined\(USE_LIGHT_PROBES\)/);
 assert.match(shader.fragmentShader,/#include <lights_physical_fragment>/,'stock geometryRoughness remains unexpanded/intact');
 assert.doesNotMatch(shader.fragmentShader,/geometryRoughness\s*=/,'stock geometry derivative AA remains available for resolved detail');
 assert.match(shader.fragmentShader,/nonPerturbedNormal = normalize\(mix\(nonPerturbedNormal,supportMacroNormal,supportLayerFilter\)\)/);
 assert.match(shader.fragmentShader,/roughnessFactor = sqrt\(min\(1\.0,roughnessFactor\*roughnessFactor/);
 assert.match(shader.fragmentShader,/supportProjectedSideCosine\(directLight.direction\)/);
 assert.match(shader.fragmentShader,/supportHemisphereMeanNormal\(\)/);
 assert.doesNotMatch(shader.fragmentShader,/diffuseColor\.rgb\s*=|gl_FragColor\.rgb\s*=/,'source material colors must not be overwritten');
 const flat=material.userData.supportLayerFilter;installSupportLayerFilter(material);assert.equal(material.userData.supportLayerFilter,flat,'installation idempotent');
 assert.throws(()=>installSupportLayerFilter(new THREE.MeshBasicMaterial()),/标准/);
 material.dispose();
});
