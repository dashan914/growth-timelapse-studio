import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {printFootprintBounds,printFootprintPlan,paintPrintFootprint,PrintLayerTextureRenderer,installPrintFootprintMaterial} from '../src/print-layer-texture.js';
import {PRINTER_MM_TO_THREE_MM} from '../src/print-layer.js';

function source(){return {segmentCount:6,layerHeights:new Float32Array([.2,.32,.44,.56]),layerOffsets:new Uint32Array([0,2,4,5,6]),layerSegments:new Uint32Array([0,1,2,3,4,5]),
  positions:new Float32Array([0,0,.2,8,0,.2,0,2,.2,8,2,.2,0,0,.32,8,0,.32,0,2,.32,8,2,.32,0,4,.44,8,4,.44,0,6,.56,8,6,.56]),
  features:new Uint8Array([3,10,1,11,5,4]),tools:new Uint16Array([0,1,1,0,0,1]),widths:new Float32Array([.42,.4,.5,.6,.42,.42]),heights:new Float32Array([.2,.2,.12,.12,.12,.12]),
  usedTools:[0,1],toolColors:['#23599c','#f0e8d6']};}
function context(){const calls=[];return{calls,save(){},restore(){},setTransform(...a){calls.push(['transform',...a]);},clearRect(...a){calls.push(['clear',...a]);},beginPath(){calls.push(['begin']);},moveTo(...a){calls.push(['move',...a]);},lineTo(...a){calls.push(['line',...a]);},stroke(){calls.push(['stroke',this.strokeStyle,this.lineWidth]);}};}
const hash=p=>createHash('sha256').update(Buffer.from(p.positions.buffer)).update(Buffer.from(p.widths.buffer)).update(Buffer.from(p.tools.buffer)).digest('hex');

test('top footprint uses actual path IDs, widths, Z, sparse gaps and support selection without filling a polygon',()=>{
  const p=source(),before=hash(p),bounds=printFootprintBounds(p);
  const plan=printFootprintPlan(p,0,{bounds,resolution:1024});
  assert.deepEqual([...plan.sourceIds],[0]);assert.equal(plan.z,p.layerHeights[0]);assert.equal(plan.maxHeight,p.heights[0]);assert.equal(plan.planar,true);
  assert.deepEqual([...printFootprintPlan(p,0,{bounds,includeSupport:true}).sourceIds],[0,1]);
  const ctx=context();paintPrintFootprint(ctx,p,plan);assert.equal(ctx.calls.filter(c=>c[0]==='move').length,1);
  assert.equal(ctx.calls.filter(c=>c[0]==='line').length,1);assert.equal(ctx.calls.find(c=>c[0]==='stroke')[2],p.widths[0]);
  assert.equal(hash(p),before);assert.equal(ctx.fill,undefined,'no synthetic filled cap');
});

test('tool coverage is deposited in actual order and filtered separately from the full-precision palette',()=>{
  const p=source(),plan=printFootprintPlan(p,0,{includeSupport:true}),ctx=context();paintPrintFootprint(ctx,p,plan);
  assert.equal(ctx.calls.filter(c=>c[0]==='stroke')[0][1],'rgb(255,0,0)');
  assert.equal(ctx.calls.filter(c=>c[0]==='stroke')[1][1],'rgb(0,255,0)');
  assert.equal(ctx.lineCap,'butt');
});

test('non-planar source deposition is explicitly flagged for real-geometry fallback',()=>{
  const p=source();p.positions[5]=.21;assert.equal(printFootprintPlan(p,0).planar,false);
});

test('latest footprint textures retain only the actual three layers and source colors; old GPU resources dispose',()=>{
  const p=source(),before=hash(p),canvases=[];
  const renderer=new PrintLayerTextureRenderer(p,{printerToSource:PRINTER_MM_TO_THREE_MM,resolution:256,createCanvas:()=>{const c={width:0,height:0,getContext:()=>context()};canvases.push(c);return c;}});
  try{
    renderer.update(.75,{includeSupport:false});assert.deepEqual([...renderer.layers.keys()],[0,1,2]);assert.equal(renderer.state.sourceSegments,3);
    const old=renderer.layers.get(0);let disposed=0;old.textures[0].addEventListener('dispose',()=>disposed++);
    renderer.update(1,{includeSupport:true});assert.deepEqual([...renderer.layers.keys()],[1,2,3]);assert.equal(disposed,1);
    assert.equal(renderer.state.displayTriangles,6);assert.equal(renderer.state.sourceSegments,4);
    for(const layer of renderer.layers.values())for(const texture of layer.textures){assert.equal(texture.generateMipmaps,true);assert.equal(texture.minFilter,THREE.LinearMipmapLinearFilter);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.premultiplyAlpha,true);}
    assert.deepEqual(renderer.root.matrix.elements,PRINTER_MM_TO_THREE_MM);assert.equal(hash(p),before);
    renderer.update(0);assert.equal(renderer.layers.size,0);assert.equal(renderer.root.visible,false);
  }finally{renderer.dispose();}
});

test('material uses float palettes including almost-black source colors and normalized roughness',()=>{
  const material=installPrintFootprintMaterial(new THREE.MeshStandardMaterial(),{tools:[0,1],colors:['#010101','#071122']});
  const shader={fragmentShader:'#include <map_fragment>\n#include <roughnessmap_fragment>',uniforms:{}};
  material.onBeforeCompile(shader,null);
  assert.match(shader.fragmentShader,/footprintRGB \/ max\(footprintAlpha/);
  assert.match(shader.fragmentShader,/diffuseColor\.a \*= footprintAlpha/);
  assert.match(shader.fragmentShader,/dot\(footprintWeights,footprintRoughness\) \/ max\(footprintAlpha/);
  assert.ok(shader.uniforms.footprintColors.value[0].r>0);assert.deepEqual(shader.uniforms.footprintColors.value[1],new THREE.Color('#071122'));
  material.dispose();
});

test('overhang roads are retained and rounded canvas dimensions use compensated source-to-pixel axes',()=>{
  const p=source();p.features[0]=16;const bounds={minX:0,minY:0,maxX:10,maxY:3,width:10,height:3};
  const plan=printFootprintPlan(p,0,{bounds,resolution:64});assert.deepEqual([...plan.sourceIds],[0]);
  assert.equal(plan.scaleX,6.4);assert.equal(plan.scaleY,20/3);
  const ctx=context();paintPrintFootprint(ctx,p,plan);assert.deepEqual(ctx.calls.find(c=>c[0]==='transform'),['transform',6.4,0,0,-20/3,-0,20]);
});

test('partial mip coverage never becomes a solid shadow blocker and failed preparation releases staged resources',()=>{
  const p=source(),factory=()=>({width:0,height:0,getContext:()=>context()});
  const renderer=new PrintLayerTextureRenderer(p,{printerToSource:PRINTER_MM_TO_THREE_MM,resolution:256,createCanvas:factory});
  try {renderer.update(1);for(const layer of renderer.layers.values())for(const mesh of layer.meshes)assert.equal(mesh.castShadow,false);}
  finally {renderer.dispose();}
  let material=null,disposed=false;
  const failed=new PrintLayerTextureRenderer(p,{printerToSource:PRINTER_MM_TO_THREE_MM,resolution:256,createCanvas:factory,
    prepareMaterial:value=>{material=value;value.addEventListener('dispose',()=>disposed=true);throw new Error('preparation failed');}});
  assert.throws(()=>failed.update(.25),/preparation failed/);assert.equal(disposed,true);assert.equal(failed.root.children.length,0);failed.dispose();
});
