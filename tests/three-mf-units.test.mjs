import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { normalizeThreeMFUnitsForLoader, THREE_MF_UNIT_TO_MM } from '../src/three-mf-units.js';

// XML-only adapter backed by Python's mature ElementTree; all unit/transform/
// geometry work is the ACTUAL fixed ThreeMFLoader, without browser/GPU or a
// replacement mesh decoder. This adapter supplies its queried DOM methods.
const XML = `import sys,json,xml.etree.ElementTree as E,io
s=sys.stdin.read();ns=dict(E.iterparse(io.StringIO(s),events=['start-ns']));prefix={v:k for k,v in ns.items()}
def n(t):
 if t.startswith('{'):
  uri,local=t[1:].split('}',1);p=prefix.get(uri,'');return (p+':' if p else '')+local
 return t
def node(e):return {'name':n(e.tag),'ns':e.tag[1:].split('}',1)[0] if e.tag.startswith('{') else None,'attrs':{n(k):v for k,v in e.attrib.items()},'text':''.join(e.itertext()),'children':[node(x) for x in e]}
r=node(E.fromstring(s));r['attrs'].update({('xmlns:'+k if k else 'xmlns'):v for k,v in ns.items()});print(json.dumps(r))`;
class XmlElement {
  constructor(input) { this.nodeName=input.name;this.localName=input.name.split(':').pop();this.namespaceURI=input.ns;this.attrs=input.attrs;this.textContent=input.text;this.attributes=Object.entries(input.attrs).map(([name,value])=>({name,value}));this.children=input.children.map(child=>new XmlElement(child)); }
  getAttribute(name) { return this.attrs[name]??null; }
  descendants() { return this.children.flatMap(child=>[child,...child.descendants()]); }
  querySelectorAll(selector) { const names=selector.split(/\s+/);let values=[this];for(const name of names)values=values.flatMap(value=>value.descendants().filter(child=>child.localName===name));return values; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  getElementsByTagNameNS(uri,name) { return this.descendants().filter(node=>node.namespaceURI===uri&&node.localName===name); }
}
globalThis.DOMParser ||= class {
  parseFromString(text) { const parsed=spawnSync('python3',['-B','-c',XML],{input:text,encoding:'utf8'});if(parsed.status!==0)throw new Error(parsed.stderr);const root=new XmlElement(JSON.parse(parsed.stdout));return{documentElement:root,querySelector:selector=>root.localName===selector?root:root.querySelector(selector),querySelectorAll:selector=>root.localName===selector?[root,...root.querySelectorAll(selector)]:root.querySelectorAll(selector)}; }
};

const ns='xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"';
const mesh=(factor=1,pid='1')=>`<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${10/factor}" y="0" z="0"/><vertex x="0" y="${10/factor}" z="0"/><vertex x="0" y="0" z="${10/factor}"/></vertices><triangles><triangle v1="0" v2="2" v3="1" pid="${pid}" p1="0"/><triangle v1="0" v2="1" v3="3" pid="${pid}" p1="1"/><triangle v1="0" v2="3" v3="2" pid="${pid}" p1="0"/><triangle v1="1" v2="2" v3="3" pid="${pid}" p1="1"/></triangles></mesh>`;
const transform=(linear,translation,factor)=>linear.concat(translation.map(value=>value/factor)).join(' ');
const identity=[1,0,0,0,1,0,0,0,1];
function archive(models,primary='3D/3dmodel.model',other={}) {
  return zipSync(Object.fromEntries(Object.entries({'_rels/.rels':`<Relationships><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/${primary}"/></Relationships>`,...models,...other}).map(([name,value])=>[name,typeof value==='string'?strToU8(value):value])));
}
function model(unit,body,build) { return `<model ${unit?`unit="${unit}"`:''} ${ns}><resources>${body}</resources><build>${build}</build></model>`; }
function unitFixture(unit) {
  const factor=THREE_MF_UNIT_TO_MM[unit]??1;
  const resource='<basematerials id="1"><base name="red" displaycolor="#FF0000"/><base name="blue" displaycolor="#0000FF"/></basematerials>';
  return archive({'3D/3dmodel.model':model(unit,`${resource}<object id="2" type="model">${mesh(factor)}</object><object id="3" type="model"><components><component objectid="2" transform="${transform([2,0,0,0,3,0,0,0,4],[5,6,7],factor)}"/></components></object>`,`<item objectid="3" transform="${transform([0,1,0,-1,0,0,0,0,1],[100,200,300],factor)}"/>`)});
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function actualLoad(input) { const normalized=normalizeThreeMFUnitsForLoader(input);return{root:new ThreeMFLoader().parse(normalized.data),normalized}; }
function vertices(root) { root.updateMatrixWorld(true);const points=[];root.traverse(node=>{if(node.isMesh)for(let i=0;i<node.geometry.attributes.position.count;i++)points.push(new THREE.Vector3().fromBufferAttribute(node.geometry.attributes.position,i).applyMatrix4(node.matrixWorld).toArray());});return points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]); }
function faceCount(root) { let faces=0;root.traverse(node=>{if(node.isMesh)faces+=(node.geometry.index?.count??node.geometry.attributes.position.count)/3;});return faces; }
function colors(root) { const values=[];root.traverse(node=>{if(node.isMesh)for(const material of [node.material].flat())values.push(material.color.getHexString());});return values.sort(); }

test('actual Loader displays cm/inch/foot/metre/micron meshes and nested transforms identically to millimetres, with untouched source ZIP and colors',()=>{
  const canonical=actualLoad(unitFixture('millimeter')).root, expected=vertices(canonical),expectedBounds=new THREE.Box3().setFromObject(canonical);
  assert.ok(expected.some(point=>point[0]===94&&point[1]===225&&point[2]===307),'independent physical point: component scale/translation then root Z90 transform');
  for(const unit of ['millimeter','centimeter','inch','foot','meter','micron',null]){
    const source=unitFixture(unit),before=hash(source),{root,normalized}=actualLoad(source);
    assert.deepEqual(vertices(root),expected,`${unit??'omitted(default mm)'} world vertices`);
    assert.deepEqual(new THREE.Box3().setFromObject(root).min.toArray(),expectedBounds.min.toArray());
    assert.deepEqual(new THREE.Box3().setFromObject(root).max.toArray(),expectedBounds.max.toArray());
    assert.equal(faceCount(root),4);assert.deepEqual(colors(root),colors(canonical));
    assert.equal(hash(source),before,'original source package never rewritten');
    assert.equal(normalized.sourceUnitsToMm,1);assert.equal(normalized.sourceUnitsInferred,false);
    assert.match(strFromU8(unzipSync(normalized.data)['3D/3dmodel.model']),/unit="millimeter"/);
  }
});

test('regression demonstrates uncorrected native unit loss and preserves genuine per-corner color attributes',()=>{
  const raw=new ThreeMFLoader().parse(unitFixture('centimeter'));
  assert.ok(vertices(raw).some(point=>Math.abs(point[0]-9.4)<1e-6&&Math.abs(point[1]-22.5)<1e-6),'actual loader ignores centimetre scale before correction');
  const group='<m:colorgroup id="1"><m:color color="#FF0000"/><m:color color="#00FF00"/><m:color color="#0000FF"/></m:colorgroup>';
  const make=unit=>{const factor=THREE_MF_UNIT_TO_MM[unit];return archive({'3D/3dmodel.model':model(unit,`${group}<object id="2" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${10/factor}" y="0" z="0"/><vertex x="0" y="${10/factor}" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" pid="1" p1="0" p2="1" p3="2"/></triangles></mesh></object>`,'<item objectid="2"/>')});};
  const baseline=actualLoad(make('millimeter')).root,normalized=actualLoad(make('meter')).root;
  const collect=root=>{const arrays=[];root.traverse(node=>{if(node.isMesh)arrays.push([...node.geometry.attributes.color.array]);});return arrays;};
  assert.deepEqual(collect(normalized),collect(baseline));
  assert.deepEqual(collect(normalized)[0],[1,0,0,0,1,0,0,0,1]);
  assert.equal(faceCount(normalized),1);assert.deepEqual(vertices(normalized),vertices(baseline));
});

test('cross-document repeated resource IDs and mixed units retain each own material and parent-unit translations',()=>{
  const rootUnit='centimeter',childUnit='inch',microUnit='micron';
  const rootBody=`<basematerials id="1"><base name="red" displaycolor="#FF0000"/><base name="blue" displaycolor="#0000FF"/></basematerials><object id="2" type="model">${mesh(10)}</object><object id="3" type="model"><components><component objectid="2" transform="${transform(identity,[1,2,3],10)}"/><component p:path="/Foreign/Part.model" objectid="3" transform="${transform(identity,[100,200,300],10)}"/><component p:path="/Models/Micro.model" objectid="2" transform="${transform(identity,[50,60,70],10)}"/></components></object>`;
  const childBody=`<basematerials id="1"><base name="green" displaycolor="#00FF00"/><base name="cyan" displaycolor="#00FFFF"/></basematerials><object id="2" type="model">${mesh(25.4)}</object><object id="3" type="model"><components><component objectid="2" transform="${transform([1.5,0,0,0,1,0,0,0,2],[4,5,6],25.4)}"/></components></object>`;
  const microBody=`<basematerials id="1"><base name="gold" displaycolor="#C89E59"/><base name="navy" displaycolor="#101B2A"/></basematerials><object id="2" type="model">${mesh(.001)}</object>`;
  const input=archive({'Root/Main.model':model(rootUnit,rootBody,`<item objectid="3" transform="${transform(identity,[10,20,30],10)}"/>`),'Foreign/Part.model':model(childUnit,childBody,'<item objectid="2" transform="1 0 0 0 1 0 0 0 1 900 900 900"/>'),'Models/Micro.model':model(microUnit,microBody,'<item objectid="999"/>')},'Root/Main.model');
  const {root,normalized}=actualLoad(input),points=vertices(root);
  assert.equal(faceCount(root),12);assert.equal(normalized.mixedUnits,true);assert.equal(normalized.resourceIDsNamespaced,true);
  assert.ok(points.some(point=>point[0]===129&&point[1]===225&&point[2]===336),'inch child physical vertex 10×1.5 plus child translation4, root component100, build10');
  assert.ok(points.some(point=>point[0]===60&&point[1]===80&&point[2]===100),'micron child origin + parent component50/60/70 + build10/20/30');
  assert.ok(points.some(point=>point[0]===11&&point[1]===22&&point[2]===33),'primary cm leaf origin + local component1/2/3 + build10/20/30');
  assert.deepEqual(colors(root),['0000ff','00ff00','00ffff','101b2a','c89e59','ff0000']);
  assert.ok(new THREE.Box3().setFromObject(root).max.x<200,'child builds are ignored, not appended to root placement');
});

test('unit normalization preserves actual Loader UVs, per-corner color properties and texture bytes',()=>{
  const png=new Uint8Array([137,80,78,71,13,10,26,10,9,8,7,6]),factor=10;
  const body=`<m:texture2d id="1" path="/Elsewhere/tex.png" contenttype="image/png"/><m:texture2dgroup id="2" texid="1"><m:tex2coord u="0" v="0"/><m:tex2coord u="1" v="0"/><m:tex2coord u="0.25" v="0.75"/></m:texture2dgroup><object id="3" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="${10/factor}" y="0" z="0"/><vertex x="0" y="${10/factor}" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2" pid="2" p1="0" p2="1" p3="2"/></triangles></mesh></object>`;
  const input=archive({'3D/3dmodel.model':model('centimeter',body,'<item objectid="3"/>')},undefined,{'Elsewhere/tex.png':png});
  const normalized=normalizeThreeMFUnitsForLoader(input),entries=unzipSync(normalized.data);
  assert.deepEqual(entries['Elsewhere/tex.png'],png);
  const copied=Object.entries(entries).find(([path])=>path.startsWith('3D/Textures/unit-'));
  assert.deepEqual(copied[1],png);
  const originalLoad=THREE.TextureLoader.prototype.load;
  try {
    THREE.TextureLoader.prototype.load=function(_url,onLoad){const texture=new THREE.Texture();queueMicrotask(()=>onLoad?.(texture));return texture;};
    const root=new ThreeMFLoader().parse(normalized.data),meshes=[];root.traverse(node=>{if(node.isMesh)meshes.push(node);});
    assert.equal(faceCount(root),1);assert.ok(meshes[0].material.map?.isTexture);
    assert.deepEqual([...meshes[0].geometry.attributes.uv.array],[0,0,1,0,.25,.75]);
    assert.deepEqual(new THREE.Box3().setFromObject(root).max.toArray(),[10,10,0]);
  } finally {THREE.TextureLoader.prototype.load=originalLoad;}
});

test('malformed units, transforms, references and recursive components fail explicitly rather than silently assuming mm',()=>{
  assert.throws(()=>normalizeThreeMFUnitsForLoader(unitFixture('furlong')),/单位/);
  const bad=archive({'3D/3dmodel.model':model('centimeter','<object id="1" type="model"><components><component objectid="1"/></components></object>','<item objectid="1"/>')});
  assert.throws(()=>normalizeThreeMFUnitsForLoader(bad),/循环/);
  const missing=archive({'3D/3dmodel.model':model('centimeter','<object id="1" type="model"><components><component objectid="99"/></components></object>','<item objectid="1"/>')});
  assert.throws(()=>normalizeThreeMFUnitsForLoader(missing),/缺少/);
  const wrong=archive({'3D/3dmodel.model':model('centimeter',`<basematerials id="1"><base displaycolor="#FF0000"/><base displaycolor="#0000FF"/></basematerials><object id="2">${mesh(10)}</object>`,'<item objectid="2" transform="1 2 3"/>')});
  assert.throws(()=>normalizeThreeMFUnitsForLoader(wrong),/矩阵/);
});

test('quoted XML greater-than and metadata-like vertex text do not alter non-geometry values',()=>{
  const text=model('centimeter',`<basematerials id="1"><base displaycolor="#FF0000"/><base displaycolor="#0000FF"/></basematerials><object id="2" name="a > b">${mesh(10)}</object>`,'<item objectid="2"/>').replace('<resources>','<!-- <vertex x="999" y="999" z="999"/> --><metadata name="sample"><![CDATA[<vertex x="1000"/>]]></metadata><resources>');
  const normalized=normalizeThreeMFUnitsForLoader(archive({'3D/3dmodel.model':text}));
  const xml=strFromU8(unzipSync(normalized.data)['3D/3dmodel.model']);
  assert.match(xml,/<!-- <vertex x="999" y="999" z="999"\/> -->/);
  assert.match(xml,/CDATA\[<vertex x="1000"\/>\]\]/);
  assert.match(xml,/name="a > b"/);
  assert.equal(faceCount(new ThreeMFLoader().parse(normalized.data)),4);
});
