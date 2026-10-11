import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { surfaceFootprintScale, filteredSemicircleRoughness } from '../src/surface-footprint.js';
import { createPrintPathMaterial, updatePrintPathCamera, printPathLayerPixelHeight, printPathLayerFilterWeight } from '../src/print-path-material.js';
import { installFDMSurface, FDM_SURFACE_GLSL } from '../src/fdm-surface.js';
import { installSupportLayerFilter, installStadiumExtrusion, supportLayerFilterWeight } from '../src/print-layer-renderer.js';

test('final-output pixel footprint remains stable when the internal renderer supersamples',()=>{
  const camera = new THREE.PerspectiveCamera(45, 1.5, .1, 100);
  const material = createPrintPathMaterial();
  const renderer = { userData: { printSurfaceFootprintScale: 2 }, getCurrentViewport: value => value.set(0,0,2880,1920) };
  updatePrintPathCamera(material, renderer, camera);
  const uniforms = material.userData.printPathImpostor.uniforms;
  assert.deepEqual(uniforms.pathViewportSize.value.toArray(), [2880,1920], 'analytic proxy bounds use actual raster pixels');
  assert.deepEqual(uniforms.pathFilterViewportSize.value.toArray(), [1440,960], 'layer filtering uses final image pixels');
  const fdm = new THREE.MeshStandardMaterial(), handle = installFDMSurface(fdm);
  fdm.onBeforeRender(renderer, {}, camera);
  assert.equal(handle.uniforms.fdmFootprintScale.value, 2);
  assert.match(FDM_SURFACE_GLSL, /cyclesPerPixel \* fdmFootprintScale/);
  const support = installSupportLayerFilter(installStadiumExtrusion(new THREE.MeshStandardMaterial()));
  support.userData.supportLayerFilter.enabled.value = 1;
  const shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};
  support.onBeforeCompile(shader, renderer);support.onBeforeRender(renderer, {}, camera);
  assert.equal(shader.uniforms.supportFootprintScale.value, 2);
  assert.match(shader.fragmentShader, /fwidth\(vSupportLayerCoordinate\)\*supportFootprintScale/);
  assert.equal(supportLayerFilterWeight(.16,.04*2), 1, 'internal two-pixel samples cannot revive a one-pixel final layer');
  for (const value of [undefined, NaN, 0, -1]) assert.equal(surfaceFootprintScale({userData:{printSurfaceFootprintScale:value}}), 1);
});

test('long tilted extrusions can cross Nyquist at their far end even when the centre looks resolved',()=>{
  const camera = new THREE.PerspectiveCamera(50, 1.5, .1, 100);
  const pixelHeight = centre => printPathLayerPixelHeight({centre,printAxisView:[0,.001,0],layerHeightMm:.16,projectionMatrix:camera.projectionMatrix,viewport:[1440,960]});
  const near = pixelHeight([0,0,-.025]), far = pixelHeight([0,0,-.15]);
  assert.ok(near > 5 && far < 2, 'the same physical road spans resolved and unresolved layer footprints');
  const side = {ratio:.16/.42,localNormal:[.8,0,.6]};
  assert.equal(printPathLayerFilterWeight({...side,pixels:near}),0);
  assert.equal(printPathLayerFilterWeight({...side,pixels:far}),1);
});

test('unresolved phase cannot modulate the specular normal derivative or filtered roughness',()=>{
  const normalAt = turn => {const z=2*(turn%1)-1;return[Math.sqrt(Math.max(0,1-z*z)),z];};
  const phases = Array.from({length:64}, (_,phase)=>(phase+.5)/64);
  const normals = phases.map(normalAt);
  const derivativeRoughness = phases.map(phase=>Math.max(...normalAt(phase+.6).map((value,k)=>Math.abs(value-normalAt(phase)[k]))));
  assert.ok(Math.max(...derivativeRoughness)-Math.min(...derivativeRoughness)>.3, 'a 1.67-pixel layer has phase-dependent geometry roughness');
  const filtered = normals.map(()=>filteredSemicircleRoughness(.3,1));
  assert.equal(Math.max(...filtered)-Math.min(...filtered),0);
  assert.ok(filtered[0]>.3 && filtered[0]<1, 'filtered-out normal variance broadens the lobe instead of making it polished');
  assert.equal(filteredSemicircleRoughness(.3,0),.3, 'resolved material roughness is unchanged');
  assert.equal(filteredSemicircleRoughness(1,1),1);
});
