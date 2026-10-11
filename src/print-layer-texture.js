import * as THREE from 'three';
import { printLayerProgressState, resolvePrintLayerPalette, validatePrintLayerMapping } from './print-layer-renderer.js';
import { resolveFDMSurfaceProfile } from './fdm-surface.js';

const modelFeature = role => role >= 1 && role <= 9 || role === 16;
const supportFeature = role => role === 10 || role === 11;

/** Screen-filterable top footprints made from the original deposited roads.
 * Empty infill cells remain transparent. No polygon filling or new slicing. */
export function printFootprintBounds(parsed) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=0;i<parsed.segmentCount;i++) {
    if(!modelFeature(parsed.features[i])&&!supportFeature(parsed.features[i]))continue;
    const p=i*6,r=parsed.widths[i]*.5;
    minX=Math.min(minX,parsed.positions[p]-r,parsed.positions[p+3]-r);
    minY=Math.min(minY,parsed.positions[p+1]-r,parsed.positions[p+4]-r);
    maxX=Math.max(maxX,parsed.positions[p]+r,parsed.positions[p+3]+r);
    maxY=Math.max(maxY,parsed.positions[p+1]+r,parsed.positions[p+4]+r);
  }
  if(![minX,minY,maxX,maxY].every(Number.isFinite))throw new TypeError('切片没有有效的打印范围。');
  return {minX,minY,maxX,maxY,width:Math.max(.001,maxX-minX),height:Math.max(.001,maxY-minY)};
}

export function printFootprintPlan(parsed, layerIndex, {includeSupport=false,bounds=printFootprintBounds(parsed),resolution=2048}={}) {
  if(!Number.isInteger(layerIndex)||layerIndex<0||layerIndex>=parsed.layerHeights.length)throw new RangeError('打印层索引无效。');
  if(!Number.isInteger(resolution)||resolution<64||resolution>4096)throw new RangeError('打印层纹理精度无效。');
  const scale=resolution/Math.max(bounds.width,bounds.height);
  const width=Math.max(1,Math.ceil(bounds.width*scale)),height=Math.max(1,Math.ceil(bounds.height*scale));
  const scaleX=width/bounds.width,scaleY=height/bounds.height;
  const selected=[];let maxHeight=0,planar=true;
  for(let at=parsed.layerOffsets[layerIndex];at<parsed.layerOffsets[layerIndex+1];at++) {
    const id=parsed.layerSegments[at],role=parsed.features[id];
    if(!modelFeature(role)&&!(includeSupport&&supportFeature(role)))continue;
    selected.push(id);maxHeight=Math.max(maxHeight,parsed.heights[id]);
    if(Math.abs(parsed.positions[id*6+2]-parsed.positions[id*6+5])>.0001)planar=false;
  }
  return {layerIndex,z:parsed.layerHeights[layerIndex],sourceIds:Uint32Array.from(selected),maxHeight,planar,bounds,scale,scaleX,scaleY,width,height,resolution};
}

/** Store per-tool COVERAGE rather than color. RGB encode the first three tools,
 * alpha contains total coverage; tool four is alpha minus RGB. Float palette
 * uniforms preserve even very dark imported colors during mip filtering. */
export function paintPrintFootprint(context, parsed, plan, {coverageTools=parsed.usedTools.slice(0,4)}={}) {
  context.clearRect(0,0,plan.width,plan.height);context.lineCap='butt';context.lineJoin='round';
  const palette=new Map(coverageTools.map((tool,index)=>[tool,['rgb(255,0,0)','rgb(0,255,0)','rgb(0,0,255)','rgb(0,0,0)'][index]]));
  context.save?.();context.setTransform?.(plan.scaleX,0,0,-plan.scaleY,-plan.bounds.minX*plan.scaleX,plan.bounds.maxY*plan.scaleY);
  let style=null,lineWidth=null,open=false;
  const flush=()=>{if(open){context.stroke();open=false;}};
  for(const id of plan.sourceIds) {
    const nextStyle=palette.get(parsed.tools[id]);if(nextStyle===undefined)continue;
    const nextWidth=parsed.widths[id];
    if(nextStyle!==style||nextWidth!==lineWidth){flush();style=nextStyle;lineWidth=nextWidth;context.strokeStyle=style;context.lineWidth=lineWidth;}
    if(!open){context.beginPath();open=true;}
    const p=id*6;
    context.moveTo(parsed.positions[p],parsed.positions[p+1]);
    context.lineTo(parsed.positions[p+3],parsed.positions[p+4]);
  }
  flush();context.restore?.();return plan.sourceIds.length;
}

export function installPrintFootprintMaterial(material,{tools=[],colors=[],preserveMaterials=true,color='#ffffff',surfacePreset='auto',materialProfiles=[]}={}) {
  const compile=material.onBeforeCompile,key=material.customProgramCacheKey.bind(material);
  const uniforms={footprintColors:{value:Array.from({length:4},(_,i)=>new THREE.Color(preserveMaterials?colors[tools[i]]||'#ffffff':color))},
    footprintRoughness:{value:new THREE.Vector4(...Array.from({length:4},(_,i)=>resolveFDMSurfaceProfile(surfacePreset,materialProfiles.find(p=>p.tool===tools[i])?.profile||'pla').roughness))}};
  material.onBeforeCompile=(shader,renderer)=>{
    compile.call(material,shader,renderer);
    Object.assign(shader.uniforms,uniforms);
    shader.fragmentShader='uniform vec3 footprintColors[4];\nuniform vec4 footprintRoughness;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
vec4 footprintWeights = texture2D(map,vMapUv);
float footprintAlpha = footprintWeights.a;
footprintWeights.a = max(0.0,footprintAlpha-dot(footprintWeights.rgb,vec3(1.0)));
vec3 footprintRGB = footprintWeights.r*footprintColors[0]+footprintWeights.g*footprintColors[1]+footprintWeights.b*footprintColors[2]+footprintWeights.a*footprintColors[3];
diffuseColor.rgb *= footprintRGB / max(footprintAlpha,0.000001);
diffuseColor.a *= footprintAlpha;
#endif`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`float roughnessFactor = roughness;
#ifdef USE_MAP
roughnessFactor *= dot(footprintWeights,footprintRoughness) / max(footprintAlpha,0.000001);
#endif`);
  };
  material.customProgramCacheKey=()=>`${key()}|premultiplied-tool-coverage-footprint-v2`;
  material.userData.printFootprint=true;material.userData.footprintUniforms=uniforms;material.needsUpdate=true;return material;
}

export class PrintLayerTextureRenderer {
  constructor(parsed,{printerToSource,toolColors,historyLayers=3,resolution=2048,prepareMaterial=material=>material,createCanvas=()=>document.createElement('canvas')}={}) {
    this.data=parsed;this.printerToSource=validatePrintLayerMapping(printerToSource);this.historyLayers=historyLayers;
    this.palette=resolvePrintLayerPalette(parsed,toolColors);
    this.resolution=resolution;this.bounds=printFootprintBounds(parsed);this.createCanvas=createCanvas;
    this.root=new THREE.Group();this.root.name='真实切片层 · 预滤波显示';this.root.matrixAutoUpdate=false;this.root.matrix.copy(this.printerToSource);
    this.root.userData={growthTransient:true,printFootprint:true};this.root.visible=false;
    this.layers=new Map();this._styleKey=null;this.prepareMaterial=prepareMaterial;this.sourceIds=new Uint32Array();
  }
  _layer(plan,options) {
    const result={plan,meshes:[],textures:[],canvases:[]};
    try {
      for(let at=0;at<this.data.usedTools.length;at+=4) {
        const tools=this.data.usedTools.slice(at,at+4);if(!plan.sourceIds.some(id=>tools.includes(this.data.tools[id])))continue;
        const canvas=this.createCanvas();canvas.width=plan.width;canvas.height=plan.height;result.canvases.push(canvas);
        const context=canvas.getContext('2d',{alpha:true});if(!context)throw new Error('无法建立打印层的预滤波画布。');
        paintPrintFootprint(context,this.data,plan,{coverageTools:tools});
        const texture=new THREE.CanvasTexture(canvas);result.textures.push(texture);texture.colorSpace=THREE.NoColorSpace;texture.premultiplyAlpha=true;
        texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.anisotropy=8;
        const material=new THREE.MeshStandardMaterial({color:'#ffffff',map:texture,roughness:1,metalness:0,
          transparent:true,premultipliedAlpha:true,alphaTest:1/255,depthWrite:true,side:THREE.DoubleSide});
        const geometry=new THREE.PlaneGeometry(plan.bounds.width,plan.bounds.height),mesh=new THREE.Mesh(geometry,material);result.meshes.push(mesh);
        installPrintFootprintMaterial(this.prepareMaterial(material),{...options,tools});
        mesh.position.set((plan.bounds.minX+plan.bounds.maxX)/2,(plan.bounds.minY+plan.bounds.maxY)/2,plan.z);
        // Mip coverage is partial, while a shadow-map alpha test is binary.
        // Actual source extrusions remain the shadow caster for these layers.
        mesh.castShadow=false;mesh.receiveShadow=true;mesh.frustumCulled=false;mesh.renderOrder=12;
        mesh.userData={growthTransient:true,printFootprint:true,sourceLayer:plan.layerIndex};this.root.add(mesh);
      }
      return result;
    }catch(error){this._disposeLayer(result);throw error;}
  }
  _disposeLayer(layer) {for(const mesh of layer.meshes){mesh.removeFromParent();mesh.geometry.dispose();mesh.material.dispose();}layer.textures.forEach(texture=>texture.dispose());}
  update(progress,options={}) {
    const state=printLayerProgressState(this.data,progress),includeSupport=options.includeSupport===true;
    const colors=resolvePrintLayerPalette(this.data,{...this.palette,...(options.toolColors||{})});
    const appearance={colors,preserveMaterials:options.preserveMaterials!==false,color:options.color||'#ffffff',surfacePreset:options.surfacePreset||'auto',materialProfiles:options.materialProfiles||[]};
    const styleKey=JSON.stringify(appearance)+`/${includeSupport}/${this.resolution}`;
    if(styleKey!==this._styleKey){for(const layer of this.layers.values())this._disposeLayer(layer);this.layers.clear();this._styleKey=styleKey;}
    const desired=new Set();const first=Math.max(0,state.layerIndex-this.historyLayers+1);let maxHeight=0,planar=true,count=0;
    if(!state.empty)for(let index=first;index<=state.layerIndex;index++) {
      desired.add(index);let layer=this.layers.get(index);
      if(!layer){const plan=printFootprintPlan(this.data,index,{includeSupport,bounds:this.bounds,resolution:this.resolution});layer=this._layer(plan,appearance);this.layers.set(index,layer);}
      maxHeight=Math.max(maxHeight,layer.plan.maxHeight);planar&&=layer.plan.planar;count+=layer.plan.sourceIds.length;
    }
    for(const[index,layer]of this.layers)if(!desired.has(index)){this._disposeLayer(layer);this.layers.delete(index);}
    this.root.visible=!state.empty&&planar&&count>0;
    this.state={...state,planar,maxHeight,sourceSegments:count,displayTriangles:this.root.visible?[...this.layers.values()].reduce((sum,layer)=>sum+layer.meshes.length*2,0):0};
    return this.state;
  }
  setAnisotropy(maximum){for(const layer of this.layers.values())for(const texture of layer.textures)texture.anisotropy=Math.max(1,Math.min(8,maximum));}
  dispose(){for(const layer of this.layers.values())this._disposeLayer(layer);this.layers.clear();this.root.removeFromParent();}
}
