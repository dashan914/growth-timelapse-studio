import * as THREE from 'three';
import { unpackPrintSurfaceLOD } from './print-surface-lod.js';
import { PrintLayerTextureRenderer } from './print-layer-texture.js';
import { installFDMSurface, resolveFDMSurfaceProfile } from './fdm-surface.js';
import { installPrintReflections, printReflectionIntensity } from './print-environment.js';
import { projectedMeshDisplayErrorPx } from './mesh-display-lod.js';
import { setPrintPathMacroSurface, setPrintPathLayerFilter, createPrintPathDisplayGeometry, refreshPrintPathDisplayAttributes, setPrintPathPreviewCount } from './print-path-material.js';

/** Owns only reversible display resources. Source geometry, source arrays,
 * growth indices and analysis packets remain owned by GrowthStudio. */
export class DisplaySurfaceController {
  constructor(studio,packet,parsed,sourceMesh,printLayers){
    this.studio=studio;this.parsed=parsed;this.sourceMesh=sourceMesh;this.printLayers=printLayers;
    this.data=packet.geometry?.isBufferGeometry?packet:unpackPrintSurfaceLOD(packet);
    this.root=new THREE.Group();this.root.name='连续打印表面 · 显示优化';this.root.matrixAutoUpdate=false;this.root.visible=false;
    this.root.userData={growthTransient:true,displaySurfaceLOD:true};
    this.skinClipPlane=new THREE.Plane();this.materials=[];this.surfaceHandles=[];this.meshes=[];this.variant='auto';this.status={active:false,reason:'not-rendered'};
    this.textureActive=false;this.hooked=new WeakSet();this.savedCounts=new Map();this.appearanceKey=null;
    this.layerHeightCache=new Float32Array(parsed.layerHeights.length);this.layerHeightCache.fill(NaN);
    this.displayDraw=null;this.activeDisplayDraw=null;this.sourceBeautyCount=null;
    try{
      this._mesh(this.data.geometry,this.data.tools);
      if(this.data.fallbackGeometry)this._mesh(this.data.fallbackGeometry,this.data.fallbackTools);
      sourceMesh.parent.add(this.root);
      this.root.matrix.copy(sourceMesh.matrix);this.root.matrixWorldNeedsUpdate=true;
      if(typeof document!=='undefined'){
        this.textures=new PrintLayerTextureRenderer(parsed,{printerToSource:printLayers.printerToSource,toolColors:printLayers.palette,historyLayers:printLayers.historyLayers,resolution:2048,
          prepareMaterial:material=>this._prepareMaterial(material,false)});
        studio.orientation.add(this.textures.root);
      }
      this.updateAppearance();
      this._installBeautyHooks();
    }catch(error){this.dispose();throw error;}
  }
  _prepareMaterial(material,side=true){
    installPrintReflections(material);this.studio._prepareModelTone(material);
    if(side){material.clippingPlanes=[this.skinClipPlane];material.clipShadows=true;
      this.surfaceHandles.push(installFDMSurface(material,{...this.studio._surfaceOptions(material.userData.toolIndex),surfaceDetail:this.studio.options.layerLines===false?0:this.studio.options.surfaceDetail??.6}));
      // Historical side finish can retain filtered physical layer grain, but
      // the actual sliced top renderer owns infill direction and pattern.
      const compile=material.onBeforeCompile,key=material.customProgramCacheKey.bind(material);
      material.onBeforeCompile=(shader,renderer)=>{compile.call(material,shader,renderer);shader.fragmentShader=shader.fragmentShader.replace(/float topSlope = [^;]+;/,'float topSlope = 0.0;');};
      material.customProgramCacheKey=()=>`${key()}|display-side-finish-only-v1`;
    }
    return material;
  }
  _mesh(geometry,tools){
    const materials=tools.map(tool=>{const material=new THREE.MeshStandardMaterial({color:'#ffffff',roughness:.74,metalness:0,side:THREE.DoubleSide});material.userData.toolIndex=tool;this.materials.push(material);return this._prepareMaterial(material);});
    const mesh=new THREE.Mesh(geometry,materials);mesh.castShadow=false;mesh.receiveShadow=true;mesh.frustumCulled=false;mesh.renderOrder=10;mesh.userData={growthTransient:true,displaySurfaceLOD:true};this.root.add(mesh);this.meshes.push(mesh);
  }
  updateAppearance(){
    const studio=this.studio,options=studio.options,profiles=studio.metadata?.materialProfiles||[];
    const key=JSON.stringify([options.preserveMaterials,options.color,options.toolColors,options.surfacePreset,options.surfaceDetail,options.layerLines,profiles,studio.metadata?.layerHeightMm]);
    if(key!==this.appearanceKey){
      for(let i=0;i<this.materials.length;i++){const material=this.materials[i],tool=material.userData.toolIndex,profile=profiles.find(item=>item.tool===tool)?.profile||'pla';
        material.color.set(options.preserveMaterials===false?options.color:options.toolColors?.[tool]||this.parsed.toolColors?.[tool]||options.color);
        material.roughness=resolveFDMSurfaceProfile(options.surfacePreset||'auto',profile).roughness;
        this.surfaceHandles[i]?.update({...studio._surfaceOptions(tool,profile),surfaceDetail:options.layerLines===false?0:options.surfaceDetail??.6});
      }
      this.appearanceKey=key;
    }
    this.applyEnvironment();this.updatePrintMatrix();
  }
  applyEnvironment(){
    const studio=this.studio,texture=studio._environmentTexture;if(!texture)return;
    for(const material of[...this.materials,...[...(this.textures?.layers.values()||[])].flatMap(layer=>layer.meshes.map(mesh=>mesh.material))]){
      const changed=material.envMap?.mapping!==texture.mapping;material.envMap=texture;material.envMapIntensity=printReflectionIntensity(studio.options);if(changed)material.needsUpdate=true;
    }
  }
  updatePrintMatrix(){for(const handle of this.surfaceHandles)handle.uniforms.fdmPrintMatrix.value.copy(this.studio._printMatrix);}
  _error(geometry,error,width,height){return projectedMeshDisplayErrorPx({errorMm:error,geometry,camera:this.studio.camera,worldMatrix:this.sourceMesh.matrixWorld,width,height});}
  _maximumLayerHeight(first,last){
    let maximum=0;
    for(let layer=first;layer<=last;layer++){
      let height=this.layerHeightCache[layer];
      if(Number.isNaN(height)){
        height=0;for(let at=this.parsed.layerOffsets[layer];at<this.parsed.layerOffsets[layer+1];at++)height=Math.max(height,this.parsed.heights[this.parsed.layerSegments[at]]);
        this.layerHeightCache[layer]=height;
      }
      maximum=Math.max(maximum,height);
    }
    return maximum;
  }
  _installBeautyHooks(){
    const source=this.sourceMesh,before=source.onBeforeRender,after=source.onAfterRender;
    this.previousSourceBefore=before;this.previousSourceAfter=after;
    this.sourceBeforeHook=(renderer,scene,camera,geometry,material,group)=>{
      before.call(source,renderer,scene,camera,geometry,material,group);
      // Shadow maps use onBeforeShadow and therefore keep every original road.
      // Override-material numerical/depth analysis also keeps the full source.
      if(this.activeDisplayDraw&&!scene.overrideMaterial&&geometry===this.activeDisplayDraw.sourceGeometry){
        this.sourceBeautyCount=geometry.instanceCount;geometry.instanceCount=0;
      }
    };
    this.sourceAfterHook=(...args)=>{this._restoreSourceDrawCount();after.call(source,...args);};
    source.onBeforeRender=this.sourceBeforeHook;source.onAfterRender=this.sourceAfterHook;
  }
  _restoreSourceDrawCount(){
    if(this.sourceBeautyCount!==null&&this.activeDisplayDraw){this.activeDisplayDraw.sourceGeometry.instanceCount=this.sourceBeautyCount;this.sourceBeautyCount=null;}
  }
  _beautyMesh(geometry){
    const source=this.sourceMesh,mesh=new THREE.Mesh(geometry,source.material);
    mesh.matrixAutoUpdate=false;mesh.castShadow=false;mesh.receiveShadow=source.receiveShadow;mesh.frustumCulled=false;mesh.renderOrder=source.renderOrder;
    mesh.userData={growthTransient:true,printPathDisplayBeauty:true};
    let saved=null;
    mesh.onBeforeRender=(renderer,scene)=>{if(scene.overrideMaterial){saved=geometry.instanceCount;geometry.instanceCount=0;}};
    mesh.onAfterRender=()=>{if(saved!==null){geometry.instanceCount=saved;saved=null;}};
    mesh.userData.restoreBeautyCount=()=>{if(saved!==null){geometry.instanceCount=saved;saved=null;}};
    return mesh;
  }
  _prepareDisplayDraw(){
    const source=this.sourceMesh,full=source.geometry,order=this.studio._gcodeOrder,support=source.userData.printPathPreview?.support;
    let draw=this.displayDraw;
    if(!draw||draw.sourceGeometry!==full||draw.sourceOrder!==order||draw.supportGeometry!==support){
      this._disposeDisplayDraw();
      const geometry=createPrintPathDisplayGeometry(full,{sourceOrder:order,coveredSegmentMask:this.data.coveredSegmentMask,fallbackSourceIndices:this.data.fallbackSourceIndices,includeSupport:!support});
      draw={sourceGeometry:full,sourceOrder:order,geometry,mesh:this._beautyMesh(geometry),supportGeometry:support,supportMesh:support?this._beautyMesh(support):null};
      this.displayDraw=draw;
    }else refreshPrintPathDisplayAttributes(draw.geometry,full);
    this.activeDisplayDraw=draw;
    Object.defineProperty(source.userData,'printPathDisplayActive',{value:draw,writable:true,configurable:true,enumerable:false});
    draw.sourcePrefixCount=full.instanceCount;
    setPrintPathPreviewCount(draw.geometry,draw.sourcePrefixCount);
    draw.mesh.material=source.material;draw.mesh.matrix.copy(source.matrix);draw.mesh.matrixWorldNeedsUpdate=true;source.parent.add(draw.mesh);
    if(draw.supportMesh&&this.studio.options.showSupports!==false){
      draw.previousSupportCount=draw.supportGeometry.instanceCount;
      setPrintPathPreviewCount(draw.supportGeometry,draw.sourcePrefixCount);
      draw.supportMesh.material=source.material;draw.supportMesh.matrix.copy(source.matrix);draw.supportMesh.matrixWorldNeedsUpdate=true;source.parent.add(draw.supportMesh);
    }
    return draw;
  }
  _finishDisplayDraw(){
    this._restoreSourceDrawCount();
    const draw=this.activeDisplayDraw;
    if(draw){for(const mesh of[draw.mesh,draw.supportMesh])if(mesh){mesh.userData.restoreBeautyCount();mesh.removeFromParent();}if(draw.previousSupportCount!==undefined){draw.supportGeometry.instanceCount=draw.previousSupportCount;delete draw.previousSupportCount;}}
    this.activeDisplayDraw=null;delete this.sourceMesh.userData.printPathDisplayActive;
  }
  _disposeDisplayDraw(){
    this._finishDisplayDraw();
    const draw=this.displayDraw;if(!draw)return;
    draw.mesh.removeFromParent();draw.supportMesh?.removeFromParent();draw.geometry.dispose();this.displayDraw=null;
    // Existing interaction cache owns supportGeometry and all full resources.
  }
  _layerHooks(){
    for(const mesh of this.printLayers.meshes.values())if(!this.hooked.has(mesh)){
      this.hooked.add(mesh);const before=mesh.onBeforeRender,after=mesh.onAfterRender;
      mesh.onBeforeRender=(renderer,scene,camera,geometry,material,group)=>{
        before.call(mesh,renderer,scene,camera,geometry,material,group);
        if(this.textureActive&&!scene.overrideMaterial){this.savedCounts.set(mesh,mesh.count);mesh.count=0;}
      };
      mesh.onAfterRender=(...args)=>{if(this.savedCounts.has(mesh)){mesh.count=this.savedCounts.get(mesh);this.savedCounts.delete(mesh);}after.call(mesh,...args);};
    }
  }
  begin(){
    const studio=this.studio,source=this.sourceMesh;
    const materials=[source.material,source.customDepthMaterial],state=materials.map(material=>({material,macro:material.userData.printPathImpostor.uniforms.pathMacroSurface.value,filter:material.userData.printPathImpostor.uniforms.pathLayerFilterEnabled.value}));
    const finish=()=>{
      this._finishDisplayDraw();
      this.root.visible=false;this.textureActive=false;if(this.textures)this.textures.root.visible=false;
      for(const[mesh,count]of this.savedCounts)mesh.count=count;this.savedCounts.clear();
      for(const item of state){setPrintPathMacroSurface(item.material,item.macro>.5);setPrintPathLayerFilter(item.material,item.filter>.5);}
    };
    try{
      studio.scene.updateMatrixWorld(true);studio.camera.updateMatrixWorld(true);
      this.root.matrix.copy(source.matrix);this.root.matrixWorldNeedsUpdate=true;this.root.updateMatrixWorld(true);this.updateAppearance();
      const size=studio._displayOutputSize||studio.renderer.getSize(new THREE.Vector2()),width=size.width??size.x,height=size.height??size.y;
      const error=this.data.geometry.attributes.position.count?this._error(this.data.geometry,this.data.stats.maxDeviationMm||.08,width,height):0;
      const fallbackError=this.data.fallbackGeometry?.attributes.position.count?this._error(this.data.fallbackGeometry,this.data.stats.maximumFallbackBaseDeviationMm||0,width,height):0;
      const print=this.printLayers.state,visible=print?.visibleLayerCount||0,historical=Math.max(0,visible-this.printLayers.historyLayers),pixelError=Math.max(error,fallbackError);
      const hasBoundedSides=this.data.geometry.attributes.position.count>0||(this.data.fallbackGeometry?.attributes.position.count||0)>0;
      const active=this.variant!=='source'&&source.visible&&hasBoundedSides&&historical>0&&Number.isFinite(pixelError)&&pixelError<=.5;
      this.skinClipPlane.set(new THREE.Vector3(0,0,-1),historical?this.parsed.layerHeights[historical-1]:-1e20).applyMatrix4(source.matrixWorld);
      this.root.visible=active;
      let displayDraw=null;
      if(active)displayDraw=this._prepareDisplayDraw();
      // Actual full roads remain the only historical shadow caster. Cached
      // beauty geometry already omits covered sides/interiors by original ID.
      for(const material of materials)setPrintPathMacroSurface(material,false);
      setPrintPathLayerFilter(source.material,this.variant!=='source');
      let textureStatus=null,textureError=Infinity;
      if(this.variant!=='source'&&this.textures&&!print?.empty){
        // Source layer sizes are immutable. Camera/gizmo movement needs only
        // the projection update, not another scan through all recent paths.
        const maximumHeight=this._maximumLayerHeight(Math.max(0,(print.layerIndex??0)-this.printLayers.historyLayers+1),print.layerIndex);
        textureError=this._error(source.geometry,maximumHeight,width,height);
        if(textureError<=.5){
          try{
            textureStatus=this.textures.update(studio.options.progress,{...studio.options,includeSupport:studio.options.showSupports!==false,materialProfiles:studio.metadata.materialProfiles});
            this.textures.setAnisotropy(studio.renderer.capabilities.getMaxAnisotropy());this.textureActive=textureStatus.planar&&textureStatus.sourceSegments>0;
            this.textures.root.visible=this.textureActive;this._layerHooks();this.applyEnvironment();
          }catch(error){this.textureActive=false;this.textures.root.visible=false;textureStatus={error:error.message};}
        }else this.textures.root.visible=false;
      }
      this.status={active,pixelError,skinErrorPx:error,fallbackErrorPx:fallbackError,historicalLayers:historical,variant:this.variant,latestTextureActive:this.textureActive,latestTextureErrorPx:textureError,latestSourceSegments:textureStatus?.sourceSegments||0,sourcePrefixCount:displayDraw?.sourcePrefixCount??source.geometry.instanceCount,compactBeautySegments:displayDraw?.geometry.instanceCount??0,compactSupportSegments:this.studio.options.showSupports!==false?displayDraw?.supportGeometry?.instanceCount??0:0,reason:active?'within-screen-error':this.variant==='source'?'research-source':historical===0?'first-real-layers':'near-source-restored',sourceRetained:true,...this.data.stats};
      return finish;
    }catch(error){finish();throw error;}
  }
  setVariant(value){if(!['auto','source','candidate'].includes(value))throw new TypeError('请选择auto/source/candidate显示对照。');this.variant=value;}
  dispose(){
    this._disposeDisplayDraw();
    if(this.sourceMesh?.onBeforeRender===this.sourceBeforeHook)this.sourceMesh.onBeforeRender=this.previousSourceBefore;
    if(this.sourceMesh?.onAfterRender===this.sourceAfterHook)this.sourceMesh.onAfterRender=this.previousSourceAfter;
    this.root?.removeFromParent();this.textures?.dispose();for(const mesh of this.meshes||[])mesh.geometry.dispose();for(const material of this.materials||[])material.dispose();
    for(const[mesh,count]of this.savedCounts||[])mesh.count=count;this.savedCounts?.clear();this.meshes=[];this.materials=[];
  }
}
