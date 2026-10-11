import * as THREE from '../node_modules/three/build/three.module.js';
import {zipSync,strToU8} from '../node_modules/three/examples/jsm/libs/fflate.module.js';
import {PRINTER_MM_TO_THREE_MM} from './print-layer.js';
import {SLICE_SOURCE_REVISION} from './slice-source-version.js';
export {SLICE_SOURCE_REVISION} from './slice-source-version.js';

const xml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const world=object=>{
  const matrix=object.matrixAutoUpdate?new THREE.Matrix4().compose(object.position,object.quaternion,object.scale):object.matrix.clone();
  return object.parent?world(object.parent).multiply(matrix):matrix;
};
const excluded=node=>node.userData?.growthTransient||node.userData?.growthPrintLayer||node.userData?.growthStencil||node.userData?.isSupport;

/** Persistent Bambu/Orca whole-facet leaf encoding. A surface material never
 * becomes a separate open volume; paint annotates the intact original mesh. */
export function encodeWholeFacePaint(tool) {
  if(!Number.isInteger(tool)||tool<0||tool>254)throw new Error('整面耗材编号无效。');
  const state=tool+1;
  if(state<=2)return(state*4).toString(16).toUpperCase();
  let remaining=state-3;const digits=[];
  while(remaining>=15){digits.push(15);remaining-=15;}
  digits.push(remaining);
  return digits.reverse().map(value=>value.toString(16).toUpperCase()).join('')+'C';
}

/** A separate, full-triangle slicing copy. Rendering geometry/materials are
 * never changed. Discrete imported materials become whole-facet paint;
 * photo textures cannot specify a physical spool and are explicitly reported. */
export function createSliceSource(studio,{preset='h2c',maxTriangles=5_000_000,maxTools=16,maxXMLBytes=256*1024*1024}={}) {
  const orientation=studio.orientation,root=orientation?.children.find(node=>!excluded(node));
  if(!root)throw new Error('没有可切片的完整模型。');
  const units=Number(studio.metadata?.sourceUnitsToMm);
  if(!Number.isFinite(units)||units<=0)throw new Error('模型单位未知，无法保持真实层高。');
  const toPrinter=new THREE.Matrix4().fromArray(PRINTER_MM_TO_THREE_MM).invert().multiply(new THREE.Matrix4().makeScale(units,units,units));
  const parentInverse=world(orientation).invert(),sourceMeshes=[],palette=[],warnings=new Set(),bounds=new THREE.Box3();
  const vertices=[],faces=[];
  let triangles=0,xmlBytes=0,baseTool=0;
  const toolFor=(material,facetRGB=null)=>{
    const source=studio._sourceMaterials?.get(material)||material;
    let hex=studio.options?.preserveMaterials===false?studio.options.color:source.color?'#'+source.color.getHexString():studio.options?.color||'#d6d6d6';
    const originalTool=source.toolIndex??material.userData?.toolIndex;
    if(Number.isInteger(originalTool)&&studio.options?.toolColors?.[originalTool])hex=studio.options.toolColors[originalTool];
    else if(facetRGB&&studio.options?.preserveMaterials!==false){
      const base=source.color||new THREE.Color(hex);
      hex='#'+new THREE.Color().setRGB(base.r*facetRGB[0],base.g*facetRGB[1],base.b*facetRGB[2],THREE.LinearSRGBColorSpace).getHexString();
    }
    if(source.map)warnings.add('网格贴图没有实际耗材编号；切片内部按部件基础颜色指定耗材，完成表面保留原贴图。');
    hex=hex.toLowerCase();
    let tool=palette.indexOf(hex);
    if(tool<0){if(palette.length>=maxTools)throw new Error(`模型基础材质超过 ${maxTools} 种耗材，请导入实际涂色 3MF 或 G-code。`);tool=palette.length;palette.push(hex);}
    return tool;
  };
  const visit=(node,skip=false)=>{
    skip ||= excluded(node);if(skip)return;
    if(node.isMesh){
      const geometry=node.geometry,position=geometry.attributes?.position,index=geometry.index;
      if(!position)throw new Error('模型缺少完整顶点。');
      const count=index?.count??position.count;
      if(count%3!==0)throw new Error('模型不是完整三角面网格。');
      const instances=node.isInstancedMesh?node.count:1;
      if(instances>4096)throw new Error('模型实例超过切片预算，不会省略实例。');
      if(triangles+count/3*instances>maxTriangles)throw new Error('模型超过完整切片面数预算，不会减面。');
      const materials=Array.isArray(node.material)?node.material:[node.material];
      const groups=Array.isArray(node.material)?geometry.groups:[{start:0,count,materialIndex:0}];
      const covered=new Uint8Array(count/3),faceTools=new Uint16Array(count/3);
      for(const group of groups){
        const material=materials[group.materialIndex];if(!material)throw new Error('模型缺少材质。');
        const source=studio._sourceMaterials?.get(material)||material,colors=geometry.attributes.color;
        let fallbackTool=null;const facetTools=new Map();
        if(source.vertexColors&&colors&&(colors.count!==position.count||![3,4].includes(colors.itemSize)))throw new Error('顶点颜色与完整模型顶点不对应，不能猜测耗材颜色。');
        for(let face=group.start/3;face<(group.start+group.count)/3;face++){
          if(!Number.isInteger(face)||face<0||face>=covered.length||covered[face])throw new Error('模型材质分组不完整或重叠。');
          let facetRGB=null;
          if(source.vertexColors&&studio.options?.preserveMaterials!==false){
            if(!colors)warnings.add('模型启用了顶点颜色但没有颜色数据；耗材暂按部件基础颜色估计。');
            else{
              const ids=[0,1,2].map(corner=>index?index.getX(face*3+corner):face*3+corner);
              if(ids.some(vertex=>!Number.isInteger(vertex)||vertex<0||vertex>=position.count))throw new Error('模型包含无效面索引。');
              const rgb=ids.map(vertex=>[colors.getX(vertex),colors.getY(vertex),colors.getZ(vertex)]);
              if(rgb.some(value=>value.some(component=>!Number.isFinite(component)||component<0||component>1)))throw new Error('顶点颜色超出普通 RGB 范围，无法准确指定实体耗材。');
              const flat=rgb.every(value=>value.every((component,axis)=>Math.abs(component-rgb[0][axis])<=1e-6));
              if(flat)facetRGB=rgb[0];
              else warnings.add('模型包含连续顶点渐变，无法对应确定的实体耗材；切片暂按部件基础颜色估计，完整原始 RGBA 外观仍保留。可导入真实涂色 3MF 或 G-code 获得准确配色。');
              if(colors.itemSize===4&&ids.some(vertex=>Math.abs(colors.getW(vertex)-1)>1e-6))warnings.add('顶点透明度不对应实体耗材透明度；原始 RGBA 渲染保持不变，切片颜色只按明确 RGB 指定。');
            }
          }
          let tool;
          if(facetRGB){const key=facetRGB.join(',');tool=facetTools.get(key);if(tool===undefined){tool=toolFor(material,facetRGB);facetTools.set(key,tool);}}
          else{if(fallbackTool===null)fallbackTool=toolFor(material);tool=fallbackTool;}
          covered[face]=1;faceTools[face]=tool;
        }
      }
      if(covered.some(value=>!value))throw new Error('模型存在未分配的三角面，不会丢弃。');
      for(let instance=0;instance<instances;instance++){
        const matrix=toPrinter.clone().multiply(parentInverse).multiply(world(node));
        if(node.isInstancedMesh){const pose=new THREE.Matrix4();node.getMatrixAt(instance,pose);matrix.multiply(pose);}
          const remap=new Map(),point=new THREE.Vector3(),reverse=matrix.determinant()<0;
          const firstVertex=vertices.length,firstFace=faces.length;
          const vertexId=vertex=>{
            if(remap.has(vertex))return remap.get(vertex);
            if(!Number.isInteger(vertex)||vertex<0||vertex>=position.count)throw new Error('模型包含无效面索引。');
            if(typeof node.getVertexPosition==='function')node.getVertexPosition(vertex,point);else point.fromBufferAttribute(position,vertex);
            point.applyMatrix4(matrix);
            if(!point.toArray().every(value=>Number.isFinite(value)&&Math.abs(value)<1e7))throw new Error('模型包含无效顶点。');
            bounds.expandByPoint(point);
            const text=`<vertex x="${point.x}" y="${point.y}" z="${point.z}"/>`,mapped=vertices.length;
            xmlBytes+=text.length;if(xmlBytes>maxXMLBytes)throw new Error('完整切片副本超过内存预算，不会减面或丢弃材质。');
            vertices.push(text);remap.set(vertex,mapped);return mapped;
          };
          for(let at=0;at<count;at+=3){
            const a=vertexId(index?index.getX(at):at),b=vertexId(index?index.getX(at+1):at+1),c=vertexId(index?index.getX(at+2):at+2);
            const text=`<triangle v1="${a}" v2="${reverse?c:b}" v3="${reverse?b:c}" paint_color="${encodeWholeFacePaint(faceTools[at/3])}"/>`;
            xmlBytes+=text.length;if(xmlBytes>maxXMLBytes)throw new Error('完整切片副本超过内存预算，不会减面或丢弃材质。');
            faces.push(text);
          }
          const faceCount=faces.length-firstFace;
          if(faceCount){
            if(!sourceMeshes.length)baseTool=faceTools[0];
            sourceMeshes.push({name:String(node.name||'mesh'),instance,firstFace,faceCount,firstVertex,vertexCount:vertices.length-firstVertex,tools:[...new Set(faceTools)]});
            triangles+=faceCount;
          }
      }
    }
    node.children?.forEach(child=>visit(child,skip));
  };
  visit(root);
  if(!triangles)throw new Error('没有可切片的三角面。');
  const bed=preset==='h2c'?[330,320]:[256,256];
  const translation=[bed[0]/2-(bounds.min.x+bounds.max.x)/2,bed[1]/2-(bounds.min.y+bounds.max.y)/2,-bounds.min.z];
  const placement=new THREE.Matrix4().makeTranslation(...translation);
  const printerToSource=toPrinter.clone().invert().multiply(placement.clone().invert()).toArray();
  // glTF primitives and OBJ material groups can be open pieces of the same
  // closed model. They must form one staged polygon soup, not separate volumes
  // for the native slicer to "repair" individually into empty shapes. The
  // original scene/mesh remains untouched; every original face is still here.
  const model=`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">OrcaSlicer-2.4.2</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources><object id="1" type="model"><mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object><object id="2" type="model"><components><component objectid="1"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 ${translation.join(' ')}"/></build></model>`;
  const metadata=`<config><object id="2"><metadata key="name" value="${xml(studio.metadata.name)}"/><metadata key="extruder" value="${baseTool+1}"/><part id="1" subtype="normal_part"><metadata key="extruder" value="${baseTool+1}"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance></plate></config>`;
  const entries={
    '[Content_Types].xml':strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels':strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model':strToU8(model),'Metadata/model_settings.config':strToU8(metadata),
    'Metadata/project_settings.config':strToU8(JSON.stringify({filament_colour:palette})),
    'Metadata/growth_source.json':strToU8(JSON.stringify({schemaVersion:1,sourceRevision:SLICE_SOURCE_REVISION,sourceName:studio.metadata.name,sourceUnitsToMm:units,triangles,geometrySimplified:false,staging:'complete-assembly-polygon-soup-with-whole-face-paint',nativeSliceRepairMayOccur:true,sourceMeshes})),
  };
  return {blob:new Blob([zipSync(entries,{level:3})],{type:'application/octet-stream'}),format:'3mf',sourceCoordinateSystem:'printer-z-up',sourceName:studio.metadata.name+'.3mf',sourceRevision:SLICE_SOURCE_REVISION,toolColors:palette,printerToSource,triangles,parts:1,sourceMeshes:sourceMeshes.length,geometrySimplified:false,nativeSliceRepairMayOccur:true,warnings:[...warnings]};
}
