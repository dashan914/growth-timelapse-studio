// Deterministic audit inputs, not replacement user models. Geometry is explicit.
import fs from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures/imports');
await fs.mkdir(out,{recursive:true});
globalThis.FileReader ||= class {readAsArrayBuffer(blob){blob.arrayBuffer().then(result=>{this.result=result;this.onloadend?.();});}readAsDataURL(blob){blob.arrayBuffer().then(result=>{this.result=`data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;this.onloadend?.();});}};

const vertices=[[-15,0,-10],[15,0,-10],[15,40,-10],[-15,40,-10],[-15,0,10],[15,0,10],[15,40,10],[-15,40,10]];
// Outward-facing six quads, twelve triangles.
const quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
const triangles=quads.flatMap(([a,b,c,d])=>[[a,b,c],[a,c,d]]);

const standard=`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<resources><basematerials id="1"><base name="Audit Blue" displaycolor="#23599CFF"/><base name="Audit Gold" displaycolor="#C89E59FF"/></basematerials>
<object id="2" type="model" name="Audit 30x40x20mm" pid="1" pindex="0"><mesh><vertices>${vertices.map(([x,y,z])=>`<vertex x="${x}" y="${-z}" z="${y}"/>`).join('')}</vertices><triangles>${triangles.map(([a,b,c],i)=>`<triangle v1="${a}" v2="${b}" v3="${c}" pid="1" p1="${i<6?0:1}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="2"/></build></model>`;
await fs.writeFile(path.join(out,'standard-two-color.3mf'),zipSync({'[Content_Types].xml':strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),'_rels/.rels':strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),'3D/3dmodel.model':strToU8(standard)}));
const centimetreArchive=unzipSync(await fs.readFile(path.join(out,'standard-two-color.3mf')));
centimetreArchive['3D/3dmodel.model']=strToU8(strFromU8(centimetreArchive['3D/3dmodel.model'])
  .replace('unit="millimeter"','unit="centimeter"')
  .replace(/\b([xyz])="(-?[\d.]+)"/g,(_,axis,value)=>`${axis}="${Number(value)/10}"`));
await fs.writeFile(path.join(out,'standard-two-color-centimetres.3mf'),zipSync(centimetreArchive));

const obj=['mtllib audit-material.mtl','o Audit30x40x20',...vertices.map(v=>'v '+v.join(' ')),'vt 0 0','vt 1 0','vt 1 1','vt 0 1'];
quads.forEach((face,i)=>{obj.push('usemtl '+(i<3?'Blue':'Gold'));obj.push('f '+face.map((id,j)=>`${id+1}/${j+1}`).join(' '));});
await fs.writeFile(path.join(out,'textured-two-color.obj'),obj.join('\n')+'\n');
await fs.writeFile(path.join(out,'audit-material.mtl'),'newmtl Blue\nKd 0.137255 0.34902 0.611765\nNs 30\nmap_Kd audit-checker.png\n\nnewmtl Gold\nKd 0.784314 0.619608 0.34902\nNs 30\n');
// Public-domain self-authored two-by-two RGBA checker, encoded PNG with Node zlib.
const {deflateSync}=await import('node:zlib');
const crc=data=>{let v=-1;for(const b of data){v^=b;for(let i=0;i<8;i++)v=(v>>>1)^((v&1)?0xedb88320:0);}return(v^-1)>>>0;};
const chunk=(type,data)=>{const h=Buffer.alloc(8);h.writeUInt32BE(data.length);h.write(type,4);const t=Buffer.alloc(4);t.writeUInt32BE(crc(Buffer.concat([Buffer.from(type),data])));return Buffer.concat([h,data,t]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,255,255,255,120,120,120,255,0,120,120,120,255,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
await fs.writeFile(path.join(out,'audit-checker.png'),png);

const stl=['solid Audit30x20x40'];
for(const ids of triangles){const points=ids.map(id=>{const[x,y,z]=vertices[id];return new THREE.Vector3(x,-z,y);});const normal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();stl.push('facet normal '+normal.toArray().join(' '),'outer loop',...points.map(p=>'vertex '+p.toArray().join(' ')),'endloop','endfacet');}
stl.push('endsolid Audit30x20x40');await fs.writeFile(path.join(out,'millimetres-static.stl'),stl.join('\n')+'\n');

const group=new THREE.Group();const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices.flat().map(n=>n/1000),3));geometry.setIndex(triangles.flat());geometry.addGroup(0,18,0);geometry.addGroup(18,18,1);geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,[new THREE.MeshStandardMaterial({color:'#23599c',roughness:.64}),new THREE.MeshStandardMaterial({color:'#c89e59',roughness:.64})]);mesh.name='Audit30x40x20mm';group.add(mesh);
const exporter=new GLTFExporter();await fs.writeFile(path.join(out,'two-color-metres.glb'),Buffer.from(await exporter.parseAsync(group,{binary:true})));
await fs.writeFile(path.join(out,'two-color-metres.gltf'),JSON.stringify(await exporter.parseAsync(group,{binary:false}),null,2));

// Embed the actual two-by-two image and UVs into a GLB; no Node canvas mocks.
const plainGlb=await fs.readFile(path.join(out,'two-color-metres.glb'));
const jsonSize=plainGlb.readUInt32LE(12),binaryHeader=20+jsonSize,binarySize=plainGlb.readUInt32LE(binaryHeader);
const gltf=JSON.parse(plainGlb.toString('utf8',20,20+jsonSize).trim());
let binary=plainGlb.subarray(binaryHeader+8,binaryHeader+8+binarySize);
const appendBuffer=(data)=>{const offset=Math.ceil(binary.length/4)*4;binary=Buffer.concat([binary,Buffer.alloc(offset-binary.length),data]);return offset;};
const uv=new Float32Array([0,0,1,0,1,1,0,1,0,0,1,0,1,1,0,1]);
const uvOffset=appendBuffer(Buffer.from(uv.buffer));const uvView=gltf.bufferViews.length;gltf.bufferViews.push({buffer:0,byteOffset:uvOffset,byteLength:uv.byteLength,target:34962});const uvAccessor=gltf.accessors.length;gltf.accessors.push({bufferView:uvView,componentType:5126,count:8,type:'VEC2'});
const pngOffset=appendBuffer(png);const pngView=gltf.bufferViews.length;gltf.bufferViews.push({buffer:0,byteOffset:pngOffset,byteLength:png.length});gltf.images=[{bufferView:pngView,mimeType:'image/png'}];gltf.samplers=[{magFilter:9728,minFilter:9728,wrapS:10497,wrapT:10497}];gltf.textures=[{sampler:0,source:0}];
for(const primitive of gltf.meshes[0].primitives)primitive.attributes.TEXCOORD_0=uvAccessor;
gltf.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};gltf.buffers[0].byteLength=binary.length;
const jsonRaw=Buffer.from(JSON.stringify(gltf));const jsonPadded=Buffer.concat([jsonRaw,Buffer.alloc((4-jsonRaw.length%4)%4,32)]);const binaryPadded=Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]);
const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(20+jsonPadded.length+8+binaryPadded.length,8);header.writeUInt32LE(jsonPadded.length,12);header.write('JSON',16);const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(binaryPadded.length);binHeader.write('BIN\0',4);
await fs.writeFile(path.join(out,'textured-two-color-metres.glb'),Buffer.concat([header,jsonPadded,binHeader,binaryPadded]));

const fbx=`; FBX 7.4.0 project file\nFBXHeaderExtension: {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7400\n}\nGlobalSettings: {\n\tVersion: 1000\n\tProperties70: {\n\t\tP: "UpAxis", "int", "Integer", "",1\n\t\tP: "UpAxisSign", "int", "Integer", "",1\n\t\tP: "FrontAxis", "int", "Integer", "",2\n\t\tP: "FrontAxisSign", "int", "Integer", "",1\n\t\tP: "CoordAxis", "int", "Integer", "",0\n\t\tP: "CoordAxisSign", "int", "Integer", "",1\n\t\tP: "UnitScaleFactor", "double", "Number", "",1\n\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",1\n\t}\n}\nObjects: {\n\tGeometry: 100, "Geometry::AuditBox", "Mesh" {\n\t\tVertices: *24 {\n\t\t\ta: ${vertices.flat().map(n=>n/10).join(',')}\n\t\t}\n\t\tPolygonVertexIndex: *24 {\n\t\t\ta: ${quads.flatMap(face=>face.map((n,i)=>i===3?-n-1:n)).join(',')}\n\t\t}\n\t}\n\tModel: 200, "Model::AuditCmBox", "Mesh" {\n\t\tVersion: 232\n\t\tProperties70: {\n\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0\n\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0\n\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1\n\t\t}\n\t}\n\tMaterial: 300, "Material::AuditBlue", "" {\n\t\tVersion: 102\n\t\tShadingModel: "phong"\n\t\tMultiLayer: 0\n\t\tProperties70: {\n\t\t\tP: "DiffuseColor", "Color", "", "A",0.137255,0.34902,0.611765\n\t\t\tP: "Shininess", "double", "Number", "",30\n\t\t}\n\t}\n}\nConnections: {\n\tC: "OO",100,200\n\tC: "OO",300,200\n\tC: "OO",200,0\n}\n`;
await fs.writeFile(path.join(out,'centimetres-static.fbx'),fbx);
const bytes=new TextEncoder().encode(fbx);const parsed=new FBXLoader().parse(bytes.buffer,'');let fbxFaces=0;parsed.traverse(n=>{if(n.isMesh)fbxFaces+=(n.geometry.index?.count||n.geometry.attributes.position.count)/3;});
const report={standard3mf:{faces:12,dimensionsMm:[30,20,40],up:'Z',palette:['#23599c','#c89e59']},obj:{faces:12,dimensionsMm:[30,40,20],up:'Y',texture:'audit-checker.png',units:'estimated-mm'},glb:{faces:12,dimensionsMetres:[.03,.04,.02],up:'Y',palette:['#23599c','#c89e59']},fbx:{faces:fbxFaces,unitScaleFactor:parsed.userData.unitScaleFactor,dimensionsFileUnits:[3,4,2],expectedDimensionsMm:[30,40,20],up:'Y',palette:['#23599c']}};
report.stl={faces:12,dimensionsFileUnits:[30,20,40],expectedDimensionsMm:[30,20,40],up:'Z',units:'estimated-mm',palette:'uniform-picker'};
report.texturedGlb={...report.glb,texture:'embedded two-by-two audit-checker.png',textureMaterial:'Blue only',externalResources:false};
if(fbxFaces!==12||parsed.userData.unitScaleFactor!==1)throw new Error('FBX audit fixture did not preserve face count or centimeter metadata');
await fs.writeFile(path.join(out,'EXPECTED.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(out,'README.md'),'# Independent import audit fixtures\n\nOwn-generated deterministic engineering fixtures. No user model is changed, no external asset or license is borrowed. All models are the same 30 × 40 × 20 mm box, 12 triangles; Z-up files encode 30 × 20 × 40 mm and are rotated by the app. FBX explicitly declares centimetres (UnitScaleFactor 1); GLB/GLTF use metres. STL/OBJ have no fixed unit and assume millimetres.\n\nImport OBJ together with audit-material.mtl and audit-checker.png. The textured GLB embeds the same PNG and UVs; only the blue material is textured, gold remains untextured. The plain GLTF is self-contained (data URI buffer).\n\nExpected source values are in EXPECTED.json. Compare equal model scale on the same calibrated photo; all should project at the same physical size. Source Y-up box has height 40 mm. Missing MTL/PNG should report a clear import error and preserve the previous model. Tiny checker deliberately uses nearest filtering so texture visibility is easy to judge. Source units and face count must not be inferred from a screenshot alone.\n\nReproduce: node tests/create-fixtures.mjs\n');
console.log(JSON.stringify(report));
