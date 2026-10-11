import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { createPrintPathGeometry, createPrintPathMaterial, createPrintPathDepthMaterial,
  createPrintPathAnalysisMaterial, updatePrintPathAnalysisRange, setPrintPathSupportVisibility,
  setPrintPathInteraction, printPathProjectedBounds,
  setPrintPathLayerFilter, printPathLayerFilterWeight, printPathLayerPixelHeight, printPathSemicircleDiffuseAverage,
  createPrintPathPreviewGeometries, setPrintPathPreviewCount, refreshPrintPathPreviewAttributes,
  patchPrintPathShader, updatePrintPathCamera, intersectPrintBead } from '../src/print-path-material.js';

const close=(actual,expected,epsilon=1e-8)=>assert.ok(Math.abs(actual-expected)<=epsilon,`${actual} != ${expected}`);
const fixture=()=>{
  const geometry=new LineSegmentsGeometry().setPositions(new Float32Array([0,0,.08, 0,10,.08, 0,0,.16, 10,0,.16, 2,1,.12, 8,1,.12]));
  geometry.setColors(new Float32Array([1,0,0, 1,0,0, 0,0,1, 0,0,1, 0,1,0, 0,1,0]));
  geometry.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(new Float32Array([.42,.5,.3]),1));
  return geometry;
};

const compactFixture=()=>{
  const features=new Uint8Array([1,2,3,4,5,10,11,7,9,12]),count=features.length;
  const positions=new Float32Array(count*6),colors=new Float32Array(count*6),widths=new Float32Array(count),heights=new Float32Array(count),roughness=new Float32Array(count);
  for(let i=0;i<count;i++){positions.set([i*2,0,.08,i*2+1,0,.08],i*6);colors.set([i/20,.2,.3,i/20,.2,.3],i*6);widths[i]=.4+i*.01;heights[i]=.16+i*.001;roughness[i]=.3+i*.03;}
  const lines=new LineSegmentsGeometry().setPositions(positions).setColors(colors);
  lines.setAttribute('instancePrintWidth',new THREE.InstancedBufferAttribute(widths,1));
  return createPrintPathGeometry(lines,{heights,features,roughness});
};

test('proxy retains all paths and shared source buffers with two triangles per segment',()=>{
  const line=fixture(), positions=Array.from(line.attributes.instanceStart.data.array);
  line.instanceCount=2;
  const heights=new Float32Array([.16,.2,.25]);
  const proxy=createPrintPathGeometry(line,{heights,features:new Uint8Array([1,1,7])});
  assert.equal(proxy.attributes.position.count,4);assert.equal(proxy.index.count,6);assert.equal(proxy.instanceCount,2);
  assert.equal(proxy.userData.sourceSegmentCount,3);
  for(const key of ['instanceStart','instanceEnd','instancePrintWidth','instanceColorStart','instanceColorEnd'])assert.equal(proxy.attributes[key],line.attributes[key]);
  assert.equal(proxy.attributes.instancePrintHeight.array,heights);
  close(proxy.attributes.instanceBeadRatio.getX(0),.16/.42,1e-7);
  assert.equal(proxy.attributes.instanceBeadRatio.getX(2),1,'bridge section is elliptical');
  assert.deepEqual(Array.from(line.attributes.instanceStart.data.array),positions);
  proxy.instanceCount=3;assert.equal(proxy.instanceCount,3,'growth can expose every source segment');
  assert.equal(proxy.attributes.instanceMatrix,undefined,'no sixteen-float matrix allocated per path');
  assert.throws(()=>createPrintPathGeometry(line,{heights:new Float32Array([.16])}),/层高/);
});

test('individual filament/profile roughness shares a compact float attribute rather than material/matrix instances',()=>{
  const line=fixture(),roughness=new Float32Array([.62,.3,.84]);
  const proxy=createPrintPathGeometry(line,{heights:new Float32Array([.16,.2,.25]),roughness});
  assert.equal(proxy.attributes.instancePrintRoughness.array,roughness);
  roughness[1]=.4;proxy.attributes.instancePrintRoughness.needsUpdate=true;
  close(proxy.attributes.instancePrintRoughness.getX(1),.4,1e-7);
  const material=createPrintPathMaterial();
  assert.deepEqual(material.defaultAttributeValues.instancePrintRoughness,[-1]);
  const shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.match(shader.fragmentShader,/roughnessFactor = clamp\(vPathRoughness, 0\.0, 1\.0\)/);
});

test('finite stadium hits preserve flat top, actual bead width and flat end caps',()=>{
  const section={width:.42,height:.16,length:10};
  const top=intersectPrintBead([0,0,1],[0,0,-1],section);
  close(top.point[2],.08);assert.deepEqual(top.normal,[0,0,1]);
  const side=intersectPrintBead([1,0,0],[-1,0,0],section);
  close(side.point[0],.21);close(side.normal[0],1);
  const cap=intersectPrintBead([.1,9,0],[0,-1,0],section);
  close(cap.point[1],5);assert.deepEqual(cap.normal,[0,1,0]);
  assert.equal(intersectPrintBead([.3,9,0],[0,-1,0],section),null,'does not invent semicircular end-cap coverage');
  assert.equal(intersectPrintBead([0,6,1],[0,0,-1],section),null,'finite road excludes surface beyond endpoint');
  const inside=intersectPrintBead([0,0,0],[0,0,1],section);close(inside.distance,.08);
});

test('rounded stadium shoulders and bridge ellipse have analytic normals and depth',()=>{
  const section={width:.42,height:.16,length:10}, shoulderX=.17;
  const hit=intersectPrintBead([shoulderX,0,1],[0,0,-1],section);
  const expectedZ=Math.sqrt(.08**2-(shoulderX-.13)**2);
  close(hit.point[2],expectedZ);close(hit.normal[0],.5);close(hit.normal[2],Math.sqrt(.75));
  const bridge=intersectPrintBead([.1,0,1],[0,0,-1],{...section,elliptical:true});
  const expectedBridgeZ=.08*Math.sqrt(1-(.1/.21)**2);close(bridge.point[2],expectedBridgeZ);
  assert.notDeepEqual(bridge.normal,hit.normal);
  const tall=intersectPrintBead([0,0,1],[0,0,-1],{width:.1,height:.2,length:1});close(tall.point[2],.1);
  const distant=intersectPrintBead([shoulderX,0,1e6],[0,0,-1],section);
  close(distant.normal[0],hit.normal[0],1e-8);close(distant.normal[2],hit.normal[2],1e-8);
  close(distant.point[2],expectedZ,1e-7,'far-camera stable roots');
  assert.throws(()=>intersectPrintBead([0,0,1],[0,0,0],section),/参数/);
});

test('oblique rays hit the same physical section with both perspective and orthographic projection',()=>{
  const section={width:.42,height:.16,length:10};
  for(const camera of [new THREE.PerspectiveCamera(47,1,.05,100),new THREE.OrthographicCamera(-1,1,1,-1,.05,100)]){
    camera.position.set(1,8,3);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2(0,0),camera);
    const hit=intersectPrintBead(ray.ray.origin.toArray(),ray.ray.direction.toArray(),section);
    assert.ok(hit);close(Math.hypot(...hit.normal),1);
    assert.ok(hit.point[1]>=-5&&hit.point[1]<=5);
    const clip=new THREE.Vector3(...hit.point).project(camera);assert.ok(clip.z>=-1&&clip.z<=1);
  }
});

test('PBR patch uses hit normals/view positions/depth while retaining real Three lighting and reflection chunks',()=>{
  const material=createPrintPathMaterial({prepareMaterial:material=>{material.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n// MODEL_GRADE_HOOK');};return material;}});
  assert.ok(material.isMeshStandardMaterial);assert.equal(material.metalness,0);
  const shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.match(shader.fragmentShader,/MODEL_GRADE_HOOK/);
  assert.match(shader.fragmentShader,/vec3 normal=pathHitNormal/);
  assert.match(shader.fragmentShader,/vec3 vViewPosition = -pathHitView/);
  assert.match(shader.fragmentShader,/gl_FragDepth = pathHitDepth/);
  assert.match(shader.fragmentShader,/RE_Direct\( directLight, geometryPosition/);
  assert.match(shader.fragmentShader,/#include <envmap_physical_pars_fragment>/);
  assert.match(shader.fragmentShader,/directionalShadowMatrix\[i\] \* vec4\(pathHitWorld/);
  assert.match(shader.fragmentShader,/vec3 vClipPosition = -pathHitView/);
  assert.doesNotMatch(shader.vertexShader,/#include <project_vertex>/);
  assert.doesNotMatch(shader.vertexShader,/for \(int pathCorner/);
  assert.equal((shader.vertexShader.match(/projectionMatrix\*vec4\(pathEnd[AB],1\.0\)/g)||[]).length,2);
  const camera=new THREE.PerspectiveCamera(60,1,.1,100);camera.position.set(1,2,3);camera.updateMatrixWorld();
  updatePrintPathCamera(material,{getCurrentViewport:target=>target.set(0,0,1440,1080)},camera);
  assert.deepEqual(shader.uniforms.pathProjection.value.elements,camera.projectionMatrix.elements);
  assert.deepEqual(shader.uniforms.pathCameraWorld.value.elements,camera.matrixWorld.elements);
  assert.deepEqual(shader.uniforms.pathViewportSize.value.toArray(),[1440,1080]);
});

test('shadow/depth patch packs the actual intersected depth and supports near/reversed/log depth conventions',()=>{
  const material=createPrintPathDepthMaterial();assert.ok(material.isMeshDepthMaterial);
  const shader={vertexShader:THREE.ShaderLib.depth.vertexShader,fragmentShader:THREE.ShaderLib.depth.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.match(shader.fragmentShader,/float fragCoordZ = pathHitDepth/);
  assert.doesNotMatch(shader.fragmentShader,/float fragCoordZ = (?:0\.5 \* )?vHighPrecisionZW/);
  assert.match(shader.fragmentShader,/log2\(1\.0-pathHitView.z\)/);
  assert.match(shader.fragmentShader,/pathProjectionInverse \* vec4\(vPathNdc, 1\.0, 1\.0\)/);
  assert.match(shader.fragmentShader,/packDepthToRGBA\( fragCoordZ \)/);
  assert.equal(material.userData.printPathImpostor.sectionApproximate,true);
});

test('support uniform toggles keep the original all-path geometry and compact feature-derived mask intact',()=>{
  const line=fixture(),proxy=createPrintPathGeometry(line,{heights:new Float32Array([.16,.2,.25]),features:new Uint8Array([1,10,11])});
  assert.ok(proxy.attributes.instancePrintSupport.array instanceof Uint8Array);
  assert.deepEqual([...proxy.attributes.instancePrintSupport.array],[0,1,1]);
  const sourceStart=proxy.attributes.instanceStart,sourceEnd=proxy.attributes.instanceEnd;
  for(const material of[createPrintPathMaterial(),createPrintPathDepthMaterial(),createPrintPathAnalysisMaterial()]){
    const uniform=material.userData.printPathImpostor.uniforms.pathHideSupport;
    assert.equal(uniform.value,0,'all paths initially visible');
    const key=material.customProgramCacheKey();
    setPrintPathSupportVisibility(material,false);assert.equal(uniform.value,1);
    setPrintPathSupportVisibility(material,true);assert.equal(uniform.value,0);
    assert.equal(material.customProgramCacheKey(),key,'checkbox requires no shader recompile');
    const library=material.isMeshDepthMaterial?'depth':material.isMeshBasicMaterial?'basic':'standard';
    const shader={vertexShader:THREE.ShaderLib[library].vertexShader,fragmentShader:THREE.ShaderLib[library].fragmentShader,uniforms:{}};
    material.onBeforeCompile(shader,{});
    assert.match(shader.vertexShader,/pathHideSupport > 0\.5 && instancePrintSupport > 0\.5/);
    assert.match(shader.vertexShader,/gl_Position = vec4\(2\.0,2\.0,0\.0,1\.0\);\s+return;/);
    assert.match(shader.fragmentShader,/pathHideSupport > 0\.5 && vPathSupport > 0\.5\) discard/);
  }
  assert.equal(proxy.attributes.instanceStart,sourceStart);assert.equal(proxy.attributes.instanceEnd,sourceEnd);
  assert.equal(proxy.instanceCount,3);assert.equal(proxy.userData.sourceSegmentCount,3);
});

test('two-end-section perspective/orthographic bounds contain original eight corners in 64 randomized affine poses',()=>{
  let seed=0x562043;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const signed=range=>(random()*2-1)*range;
  let checkedCorners=0,croppedCases=0;
  for(let pose=0;pose<64;pose++){
    const a=new THREE.Vector3(signed(1),signed(1),signed(.2)),b=a.clone().add(new THREE.Vector3(signed(2.5)+.01,signed(2.5)+.01,signed(.2)));
    const delta=b.clone().sub(a),len=Math.hypot(delta.x,delta.y),width=.06+random()*.9,height=.05+random()*.4;
    const sourceRight=new THREE.Vector3(delta.y/len,-delta.x/len,0).multiplyScalar(width/2),sourceUp=new THREE.Vector3(0,0,height/2);
    const position=new THREE.Vector3(signed(.5),signed(.5),signed(.5));
    const matrix=new THREE.Matrix4().compose(position,new THREE.Quaternion().setFromEuler(new THREE.Euler(signed(Math.PI),signed(Math.PI),signed(Math.PI))),new THREE.Vector3(.5+random(),.5+random(),.5+random()));
    matrix.multiply(new THREE.Matrix4().makeShear(signed(.15),signed(.15),signed(.15),signed(.15),signed(.15),signed(.15)));
    for(const projectionKind of ['perspective','perspective-cropped','orthographic-shadow','orthographic-cropped']){
      const camera=projectionKind.startsWith('perspective')?new THREE.PerspectiveCamera(20+random()*65,1.5,.03,100):new THREE.OrthographicCamera(-3,3,2,-2,.03,100);
      camera.position.set(2+random()*2,-3-random()*2,3+random()*3);camera.lookAt(position);camera.updateMatrixWorld();
      if(projectionKind.endsWith('cropped')){camera.setViewOffset(2400,1600,random()*600,random()*450,1500+random()*600,1000+random()*400);croppedCases++;}
      const modelViewMatrix=camera.matrixWorldInverse.clone().multiply(matrix);
      const bounds=printPathProjectedBounds({start:a.toArray(),end:b.toArray(),width,height,modelViewMatrix,projectionMatrix:camera.projectionMatrix,viewport:[1440,1080]});
      assert.equal(bounds.projectionCount,2);
      close(bounds.pixelExpansion[0]*1440/2,1);close(bounds.pixelExpansion[1]*1080/2,1);
      if(bounds.acrossCamera){assert.deepEqual(bounds.min,[-1,-1]);assert.deepEqual(bounds.max,[1,1]);continue;}
      for(const endpoint of[a,b])for(const x of[-1,1])for(const z of[-1,1]){
        const point=endpoint.clone().addScaledVector(sourceRight,x).addScaledVector(sourceUp,z).applyMatrix4(modelViewMatrix);
        const clip=new THREE.Vector4(...point.toArray(),1).applyMatrix4(camera.projectionMatrix),ndc=[clip.x/clip.w,clip.y/clip.w];
        for(let axis=0;axis<2;axis++)assert.ok(ndc[axis]>=bounds.rawMin[axis]-1e-9&&ndc[axis]<=bounds.rawMax[axis]+1e-9,`${projectionKind} pose ${pose} corner ${ndc} outside ${bounds.rawMin}/${bounds.rawMax}`);
        checkedCorners++;
      }
      for(let axis=0;axis<2;axis++){
        if(bounds.rawMin[axis]>-1+bounds.pixelExpansion[axis]&&bounds.rawMin[axis]<1)close(bounds.min[axis],bounds.rawMin[axis]-bounds.pixelExpansion[axis]);
        if(bounds.rawMax[axis]<1-bounds.pixelExpansion[axis]&&bounds.rawMax[axis]>-1)close(bounds.max[axis],bounds.rawMax[axis]+bounds.pixelExpansion[axis]);
      }
    }
  }
  assert.equal(croppedCases,128);assert.ok(checkedCorners>=1800,`verified ${checkedCorners} projected corners`);
});

test('perspective bounds conservatively handle near-camera crossing and fully behind-camera roads',()=>{
  const camera=new THREE.PerspectiveCamera(50,1,.03,10);
  const parameters={start:[-1,0,0],end:[1,0,0],width:.42,height:.16,projectionMatrix:camera.projectionMatrix,viewport:[1080,720]};
  const across=printPathProjectedBounds({...parameters,modelViewMatrix:new THREE.Matrix4()});
  assert.equal(across.acrossCamera,true);assert.equal(across.entirelyBehind,false);assert.deepEqual(across.min,[-1,-1]);assert.deepEqual(across.max,[1,1]);
  const behind=printPathProjectedBounds({...parameters,modelViewMatrix:new THREE.Matrix4().makeTranslation(0,0,1)});
  assert.equal(behind.entirelyBehind,true);assert.deepEqual(behind.min,[2,2]);assert.deepEqual(behind.max,[2,2]);
  const beforeNear=printPathProjectedBounds({...parameters,modelViewMatrix:new THREE.Matrix4().makeTranslation(0,0,-.025)});
  assert.equal(beforeNear.acrossCamera,true,'large section intersects eye plane and must conservatively cover the viewport');
});

test('interaction reduces only the AA guard band to quarter pixel while retaining exact bounds and final one-pixel coverage',()=>{
  const camera=new THREE.PerspectiveCamera(50,1.5,.03,100);
  camera.setViewOffset(2400,1600,320,180,1600,1100);
  const options={start:[-.4,.2,0],end:[.4,.2,0],width:.42,height:.16,modelViewMatrix:new THREE.Matrix4().makeTranslation(0,0,-5),projectionMatrix:camera.projectionMatrix,viewport:[1440,1080]};
  const full=printPathProjectedBounds(options),interaction=printPathProjectedBounds({...options,interaction:true});
  assert.deepEqual(interaction.rawMin,full.rawMin);assert.deepEqual(interaction.rawMax,full.rawMax);
  for(let axis=0;axis<2;axis++){
    close(full.pixelExpansion[axis]*options.viewport[axis]/2,1);
    close(interaction.pixelExpansion[axis]*options.viewport[axis]/2,.25);
    assert.ok(interaction.min[axis]<=interaction.rawMin[axis]);assert.ok(interaction.max[axis]>=interaction.rawMax[axis]);
    assert.ok(interaction.min[axis]>=full.min[axis]);assert.ok(interaction.max[axis]<=full.max[axis]);
  }
  const material=createPrintPathMaterial(),shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.match(shader.vertexShader,/pathPixel = \(pathInteraction > 0\.5 \? 0\.5 : 2\.0\) \/ max\(pathViewportSize/);
  assert.equal(material.userData.printPathImpostor.uniforms.pathInteraction.value,0,'final frame default still has full AA margin');
});

test('temporary interaction omits only roles 2/3/4 before projection without changing stationary or export source paths',()=>{
  const line=fixture(),features=new Uint8Array([1,2,10]);
  const proxy=createPrintPathGeometry(line,{heights:new Float32Array([.16,.2,.25]),features});
  assert.equal(proxy.attributes.instancePrintRole.array,features,'original reordered role buffer is shared');
  for(const material of[createPrintPathMaterial(),createPrintPathDepthMaterial(),createPrintPathAnalysisMaterial({heights:true})]){
    const uniform=material.userData.printPathImpostor.uniforms.pathInteraction;
    assert.equal(uniform.value,0,'stationary/final defaults preserve every path');
    const programKey=material.customProgramCacheKey();setPrintPathInteraction(material,true);assert.equal(uniform.value,1);setPrintPathInteraction(material,false);assert.equal(uniform.value,0);assert.equal(material.customProgramCacheKey(),programKey);
    const kind=material.isMeshDepthMaterial?'depth':material.isMeshBasicMaterial?'basic':'standard';
    const shader={vertexShader:THREE.ShaderLib[kind].vertexShader,fragmentShader:THREE.ShaderLib[kind].fragmentShader,uniforms:{}};
    material.onBeforeCompile(shader,{});
    assert.match(shader.vertexShader,/pathInteraction > 0\.5 && instancePrintRole >= 2\.0 && instancePrintRole <= 4\.0/);
    assert.match(shader.fragmentShader,/pathInteraction > 0\.5 && vPathRole >= 2\.0 && vPathRole <= 4\.0/);
    assert.ok(shader.vertexShader.indexOf('gl_Position = vec4(2.0,2.0,0.0,1.0);')<shader.vertexShader.indexOf('vec3 pathDelta ='),'suppressed roads skip projection work');
  }
  assert.equal(proxy.instanceCount,3);assert.equal(proxy.userData.sourceSegmentCount,3);assert.deepEqual([...features],[1,2,10]);
});

test('subpixel layer filtering smoothly preserves resolved layers and excludes caps/flats/ellipses',()=>{
  const ordinary={ratio:.16/.42,localNormal:[.8,0,.6]};
  close(printPathLayerFilterWeight({...ordinary,pixels:.25}),1);
  close(printPathLayerFilterWeight({...ordinary,pixels:.75}),1);
  close(printPathLayerFilterWeight({...ordinary,pixels:2}),1);
  close(printPathLayerFilterWeight({...ordinary,pixels:3.5}),.5);
  close(printPathLayerFilterWeight({...ordinary,pixels:5}),0);
  close(printPathLayerFilterWeight({...ordinary,pixels:8}),0);
  close(printPathLayerFilterWeight({...ordinary,pixels:.1,enabled:false}),0);
  for(const localNormal of[[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]])close(printPathLayerFilterWeight({...ordinary,pixels:.1,localNormal}),0);
  close(printPathLayerFilterWeight({...ordinary,pixels:.1,ratio:1}),0);
  let previous=1;
  for(let pixels=.1;pixels<=6;pixels+=.05){const current=printPathLayerFilterWeight({...ordinary,pixels});assert.ok(current<=previous+1e-12);previous=current;}
  close(printPathSemicircleDiffuseAverage(1,0),Math.PI/4);
  close(printPathSemicircleDiffuseAverage(-1,0),0);
  close(printPathSemicircleDiffuseAverage(0,1),.25);
  close(printPathSemicircleDiffuseAverage(0,-1),.25);
  close(printPathSemicircleDiffuseAverage(0,0),0);
  for(const[a,b]of[[1,0],[-1,0],[0,1],[0,-1],[.4,.9],[-.6,.8]]){
    let integral=0;const steps=4096,step=Math.PI/steps;
    for(let i=0;i<steps;i++){const theta=-Math.PI/2+(i+.5)*step;integral+=Math.max(0,a*Math.cos(theta)+b*Math.sin(theta))*Math.cos(theta)*step/2;}
    close(printPathSemicircleDiffuseAverage(a,b),integral,1e-7);
  }
});

test('centre Jacobian computes full physical layer pixels without additional projection loops or crop-shift error',()=>{
  const cases=[new THREE.PerspectiveCamera(50,1.5,.1,100),new THREE.PerspectiveCamera(50,1.5,.1,100),new THREE.OrthographicCamera(-3,3,2,-2,.1,100)];
  cases[1].setViewOffset(2400,1600,350,200,1600,1100);
  const centre=[.2,-.4,-5],axis=[.003,.001,-.002],height=.16,viewport=[1440,1080];
  for(const camera of cases){
    const actual=printPathLayerPixelHeight({centre,printAxisView:axis,layerHeightMm:height,projectionMatrix:camera.projectionMatrix,viewport});
    const endpoints=[-1,1].map(sign=>new THREE.Vector4(...centre.map((value,i)=>value+sign*axis[i]*height/2),1).applyMatrix4(camera.projectionMatrix));
    const finiteDifference=Math.hypot(...[0,1].map(i=>((i===0?endpoints[1].x:endpoints[1].y)/endpoints[1].w-(i===0?endpoints[0].x:endpoints[0].y)/endpoints[0].w)*viewport[i]/2));
    close(actual,finiteDifference,1e-8);
  }
  const doubled=printPathLayerPixelHeight({centre,printAxisView:axis,layerHeightMm:height*2,projectionMatrix:cases[0].projectionMatrix,viewport});
  const single=printPathLayerPixelHeight({centre,printAxisView:axis,layerHeightMm:height,projectionMatrix:cases[0].projectionMatrix,viewport});close(doubled,single*2);
});

test('default layer filter keeps exact path topology/depth while filtering unresolved diffuse and specular phase',()=>{
  const line=fixture(),proxy=createPrintPathGeometry(line,{heights:new Float32Array([.16,.2,.25]),features:new Uint8Array([1,10,7])});
  const paths=Array.from(proxy.attributes.instanceStart.data.array),indices=Array.from(proxy.index.array),count=proxy.instanceCount;
  const material=createPrintPathMaterial(),uniform=material.userData.printPathImpostor.uniforms.pathLayerFilterEnabled,key=material.customProgramCacheKey();
  assert.equal(uniform.value,1,'imported full-height paths must filter even without an optional display-surface controller');setPrintPathLayerFilter(material,false);assert.equal(uniform.value,0);setPrintPathLayerFilter(material,true);assert.equal(uniform.value,1);assert.equal(material.customProgramCacheKey(),key);
  const shader={vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader,uniforms:{}};
  material.onBeforeCompile(shader,{});
  assert.equal((shader.vertexShader.match(/projectionMatrix\*vec4\(pathEnd[AB],1\.0\)/g)||[]).length,2,'filter does not add a projection sampling loop');
  assert.match(shader.fragmentShader,/vPathPrintAxisView.xy\*pathDepth\+pathHitView.xy\*vPathPrintAxisView.z/);
  assert.match(shader.fragmentShader,/1\.0-smoothstep\(2\.0,5\.0,pathLayerPixels\)/);
  assert.match(shader.fragmentShader,/directLight.color \* pathProjectedSideCosine\(directLight.direction\)/);
  assert.match(shader.fragmentShader,/pathHemisphereMeanNormal\(\)/);
  assert.match(shader.fragmentShader,/vec3 nonPerturbedNormal=normal/);
  assert.match(shader.fragmentShader,/nonPerturbedNormal = normalize\(mix\(nonPerturbedNormal,pathLayerMacroNormal,pathLayerWeight\)\)/);
  assert.match(shader.fragmentShader,/roughnessFactor = sqrt\(min\(1\.0,roughnessFactor\*roughnessFactor/);
  assert.match(shader.fragmentShader,/abs\(pathLocalNormal.y\) < 0\.0001 && abs\(pathLocalNormal.x\) > 0\.000001/);
  assert.match(shader.fragmentShader,/vPathSection.w < 0\.999999/);
  for(const unshaded of[createPrintPathDepthMaterial(),createPrintPathAnalysisMaterial({heights:true})]){
    setPrintPathLayerFilter(unshaded,true);assert.equal(unshaded.userData.printPathImpostor.uniforms.pathLayerFilterEnabled.value,0);
    const kind=unshaded.isMeshDepthMaterial?'depth':'basic';const unshadedShader={vertexShader:THREE.ShaderLib[kind].vertexShader,fragmentShader:THREE.ShaderLib[kind].fragmentShader,uniforms:{}};
    unshaded.onBeforeCompile(unshadedShader,{});
    assert.doesNotMatch(unshadedShader.vertexShader,/pathLayerStep =/);
    assert.doesNotMatch(unshadedShader.fragmentShader,/pathProjectedSideCosine/);
    assert.match(unshadedShader.fragmentShader,/gl_FragDepth = pathHitDepth/);
  }
  assert.deepEqual(Array.from(proxy.attributes.instanceStart.data.array),paths);assert.deepEqual(Array.from(proxy.index.array),indices);assert.equal(proxy.instanceCount,count);
});

test('white silhouette and RG16 height analysis use analytic hit depth and physical world Y, not quad coordinates',()=>{
  const silhouette=createPrintPathAnalysisMaterial();
  assert.ok(silhouette.isMeshBasicMaterial);assert.equal(silhouette.vertexColors,false);assert.equal(silhouette.toneMapped,false);assert.equal(silhouette.fog,false);
  assert.equal(silhouette.color.getHexString(),'ffffff');
  const height=createPrintPathAnalysisMaterial({heights:true,minY:-.3,span:2.5});
  updatePrintPathAnalysisRange(height,{minY:1,span:3});
  const uniforms=height.userData.printPathImpostor.uniforms;
  assert.equal(uniforms.pathAnalysisMinY.value,1);assert.equal(uniforms.pathAnalysisSpan.value,3);
  assert.throws(()=>updatePrintPathAnalysisRange(height,{minY:1,span:0}),/范围/);
  assert.throws(()=>updatePrintPathAnalysisRange(silhouette,{minY:1,span:3}),/范围/);
  for(const material of[silhouette,height]){
    const shader={vertexShader:THREE.ShaderLib.basic.vertexShader,fragmentShader:THREE.ShaderLib.basic.fragmentShader,uniforms:{}};
    material.onBeforeCompile(shader,{});
    assert.match(shader.fragmentShader,/pathIntersect\(pathLocalOrigin, pathLocalRay/);
    assert.match(shader.fragmentShader,/gl_FragDepth = pathHitDepth/);
    assert.match(shader.fragmentShader,/vec3 vClipPosition = -pathHitView/);
    assert.doesNotMatch(shader.fragmentShader,/vec4 vDirectionalShadowCoord\[NUM_DIR_LIGHT_SHADOWS\]/,'basic mask does not pull unsupported PBR lighting uniforms');
    if(material===height){
      assert.match(shader.fragmentShader,/pathWorldY = \(pathCameraWorld \* vec4\(pathHitView,1\.0\)\)\.y/);
      assert.match(shader.fragmentShader,/65535\.0\+0\.5/);
      assert.match(shader.fragmentShader,/floor\(packedHeight\/256\.0\)\/255\.0,mod\(packedHeight,256\.0\)\/255\.0/);
      assert.doesNotMatch(shader.fragmentShader,/#include <colorspace_fragment>|#include <tonemapping_fragment>/,'numerical channels avoid color grading');
      assert.equal(shader.uniforms.pathAnalysisSpan,uniforms.pathAnalysisSpan);
      assert.doesNotMatch(shader.vertexShader,/maskWorldY/,'does not interpolate proxy world height');
    }
  }
});

test('compact interaction views truly reduce draw instances and retain layer-ordered source mappings without touching full geometry',()=>{
  const full=compactFixture();full.instanceCount=4;
  const fullStart=full.getAttribute('instanceStart'),sourcePositions=Array.from(fullStart.data.array);
  const previews=createPrintPathPreviewGeometries(full),exterior=previews.exterior,support=previews.support;
  assert.equal(previews.sourceSegmentCount,10);assert.equal(previews.exteriorSegmentCount,5);assert.equal(previews.supportSegmentCount,2);assert.equal(previews.excludedInteractionSegments,3);
  assert.deepEqual([...exterior.sourceIndices],[0,4,7,8,9]);assert.deepEqual([...support.sourceIndices],[5,6]);
  assert.equal(exterior.instanceCount,5,'default contains every compact exterior instance');assert.equal(support.instanceCount,2);
  assert.equal(exterior.getAttribute('instanceStart').count,5);assert.equal(support.getAttribute('instanceStart').count,2);
  for(const geometry of[exterior,support])for(const[name,attribute]of Object.entries(geometry.attributes)){
    const source=full.getAttribute(name),instanced=attribute.isInstancedBufferAttribute||attribute.data?.isInstancedInterleavedBuffer;
    if(instanced)for(const[index,sourceIndex]of geometry.sourceIndices.entries())for(let component=0;component<attribute.itemSize;component++)close(attribute.getComponent(index,component),source.getComponent(sourceIndex,component));
  }
  assert.equal(exterior.getAttribute('instanceStart').data,exterior.getAttribute('instanceEnd').data,'start/end copied once per interleaved buffer');
  assert.equal(exterior.getAttribute('instanceColorStart').data,exterior.getAttribute('instanceColorEnd').data,'both color ends share one copied buffer');
  assert.notEqual(exterior.getAttribute('instanceStart').data,fullStart.data);
  assert.equal(full.instanceCount,4);assert.equal(full.getAttribute('instanceStart'),fullStart);assert.deepEqual(Array.from(fullStart.data.array),sourcePositions);
  for(let prefix=0;prefix<=10;prefix++){
    assert.equal(setPrintPathPreviewCount(exterior,prefix),[0,4,7,8,9].filter(index=>index<prefix).length);
    assert.equal(setPrintPathPreviewCount(support,prefix),[5,6].filter(index=>index<prefix).length);
  }
  assert.throws(()=>setPrintPathPreviewCount(exterior,11),/范围/);
  assert.equal(refreshPrintPathPreviewAttributes(previews,full),0,'unchanged source performs no copies or allocations');
});

test('compact color/profile refresh copies only dirty buffers and respects shared interleaved versions',()=>{
  const full=compactFixture(),previews=createPrintPathPreviewGeometries(full);
  const color=full.getAttribute('instanceColorStart'),roughness=full.getAttribute('instancePrintRoughness');
  color.setXYZ(4,.9,.8,.7);color.data.needsUpdate=true;
  roughness.setX(5,.95);roughness.needsUpdate=true;
  assert.equal(refreshPrintPathPreviewAttributes(previews,full),4,'one color and one roughness buffer per bucket, not two color buffers');
  close(previews.exterior.getAttribute('instanceColorStart').getX(1),.9,1e-7);
  close(previews.support.getAttribute('instancePrintRoughness').getX(0),.95,1e-7);
  assert.equal(refreshPrintPathPreviewAttributes(previews,full),0,'already refreshed versions avoid repeated scans');
  const role=full.getAttribute('instancePrintRole');role.setX(1,1);role.needsUpdate=true;
  assert.throws(()=>refreshPrintPathPreviewAttributes(previews,full),/重新构建/,'changed classification cannot silently use stale source mappings');
});

test('disposing compact views cannot dispose production GPU attribute identities; empty support bucket is safe',()=>{
  const full=compactFixture(),previews=createPrintPathPreviewGeometries(full);let productionDisposes=0;
  full.addEventListener('dispose',()=>productionDisposes++);
  for(const preview of[previews.exterior,previews.support]){
    assert.notEqual(preview.index,full.index);assert.equal(preview.index.array,full.index.array,'tiny immutable quad array is shared');
    for(const[name,attribute]of Object.entries(preview.attributes)){
      const source=full.getAttribute(name);assert.notEqual(attribute,source);
      if(attribute.data)assert.notEqual(attribute.data,source.data,'WebGLAttributes buffer ownership is independent');
      else if(!attribute.isInstancedBufferAttribute)assert.equal(attribute.array,source.array,'static CPU quad data shared with independent GPU wrappers');
    }
    assert.notEqual(preview.boundingBox,full.boundingBox);assert.deepEqual(preview.boundingBox,full.boundingBox);
    assert.notEqual(preview.boundingSphere,full.boundingSphere);assert.deepEqual(preview.boundingSphere,full.boundingSphere);
    preview.dispose();assert.equal(preview.userData.printPathPreview.disposed,true);
    assert.throws(()=>setPrintPathPreviewCount(preview,1),/范围/);
  }
  assert.equal(productionDisposes,0);assert.equal(full.getAttribute('instanceStart').count,10);
  const emptyFull=createPrintPathGeometry(fixture(),{heights:new Float32Array([.16,.2,.25]),features:new Uint8Array([1,2,3])});
  const empty=createPrintPathPreviewGeometries(emptyFull);assert.equal(empty.support.instanceCount,0);assert.equal(setPrintPathPreviewCount(empty.support,3),0);
});

