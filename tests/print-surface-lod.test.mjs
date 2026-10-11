import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parsePrintLayerGCode } from '../src/print-layer.js';
import { buildPrintSurfaceLOD, buildPrintFallbackRibbons, simplifyClosedRing, ringIsSimple, packPrintSurfaceLOD, unpackPrintSurfaceLOD, printSurfaceLODTransferables } from '../src/print-surface-lod.js';

const hash=array=>createHash('sha256').update(Buffer.from(array.buffer,array.byteOffset,array.byteLength)).digest('hex');
const square=(x,y,size)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size]];
function slicedLoops({layers=20,holes=true,open=true,changeTool=false,holeStarts=0}={}){
  let e=0,lines=[';filament_colour=#efeadb;#245fa9','G21','G90','M82'];
  const ring=(points,z,tool)=>{
    lines.push(`T${tool}`,';TYPE:Outer wall',';WIDTH:0.42',';HEIGHT:0.16',`G0 X${points[0][0]} Y${points[0][1]} Z${z}`);
    for(let i=1;i<=points.length;i++){const p=points[i%points.length];e++;lines.push(`G1 X${p[0]} Y${p[1]} E${e}`);}
  };
  for(let layer=0;layer<layers;layer++){
    const z=(layer+1)*.16;lines.push(';LAYER_CHANGE');ring(square(0,0,10),z,changeTool&&layer>=layers/2?1:0);
    if(holes&&layer>=holeStarts)ring(square(3,3,4),z,changeTool&&layer>=layers/2?1:0);
    if(open){lines.push(';TYPE:Outer wall',`G0 X20 Y0 Z${z}`);e++;lines.push(`G1 X23 Y0 E${e}`);e++;lines.push(`G1 X23 Y3 E${e}`);}
    lines.push(';TYPE:Sparse infill',`G0 X1 Y1 Z${z}`);e++;lines.push(`G1 X2 Y1 E${e}`);
    lines.push(';TYPE:Top surface',`G0 X1 Y2 Z${z}`);e++;lines.push(`G1 X2 Y2 E${e}`);
    lines.push(';TYPE:Bridge',`G0 X1 Y3 Z${z}`);e++;lines.push(`G1 X2 Y3 E${e}`);
  }
  return parsePrintLayerGCode(lines.join('\n'),{includeSupport:true});
}

test('closed contour simplification preserves architectural corners and rejects crossing polygons',()=>{
  const points=[[0,0],[2,0],[4,0],[4,2],[4,4],[2,4],[0,4],[0,2]],ring=simplifyClosedRing(points,{errorMm:.08});
  assert.deepEqual(ring.points,[[0,0],[4,0],[4,4],[0,4]]);assert.deepEqual([...ring.corners],[1,1,1,1]);
  assert.equal(ringIsSimple([[0,0],[4,4],[0,4],[4,0]]),false);assert.equal(simplifyClosedRing([[0,0],[4,4],[0,4],[4,0]]),null);
  assert.deepEqual(points[1],[2,0],'source contour untouched');
});

test('continuous skin merges stable layer walls while preserving open paths, holes and every source array',async()=>{
  const p=slicedLoops(),keys=['positions','tools','features','widths','heights','strokes','layers','layerOffsets','layerSegments','layerHeights'],before=Object.fromEntries(keys.map(key=>[key,hash(p[key])]));
  const result=await buildPrintSurfaceLOD(p,{offsetEnvelope:false,useMeshoptimizer:false});
  assert.equal(result.stats.closedLoops,40);assert.equal(result.stats.tracks,2);assert.equal(result.stats.matchedLayerLinks,38);
  assert.equal(result.stats.coveredOuterSegments,160);assert.equal(result.fallbackSourceIndices.length,40,'unclosed two-segment strokes preserved for exact renderer');
  assert.equal(result.fallbackGeometry.index.count/3,40*4,'each uncertain road has two independent flat sides');
  assert.ok(result.stats.triangles<40,'20-layer identical wall rings become two continuous skins');
  assert.equal(result.geometry.userData.displayOnly,true);assert.equal(result.stats.reSliced,false);
  for(const key of keys)assert.equal(hash(p[key]),before[key]);
  // No horizontal triangles/caps are introduced over the hole or sparse fill.
  const positions=result.geometry.attributes.position.array,index=result.geometry.index.array;
  for(let i=0;i<index.length;i+=3){const z=[positions[index[i]*3+2],positions[index[i+1]*3+2],positions[index[i+2]*3+2]];assert.ok(Math.max(...z)-Math.min(...z)>1e-8);}
  for(let id=0;id<p.segmentCount;id++)if([3,5,7].includes(p.features[id]))assert.equal(result.coveredSegmentMask[id],0,'fill/top/bridge still belong to original paths');
  const normals=result.geometry.attributes.normal.array;assert.ok([...normals].every(Number.isFinite));
  const holeNormals=[];for(let v=0;v<positions.length/3;v++)if(Math.abs(positions[v*3]-3)<1e-6&&Math.abs(positions[v*3+1]-3)<1e-6)holeNormals.push([...normals.slice(v*3,v*3+3)]);
  assert.ok(holeNormals.some(n=>n[0]>.99)||holeNormals.some(n=>n[1]>.99),'inner hole skin points into the hole');
});

test('hole birth and material changes break layer tracks rather than bridging openings or blending filament colors',async()=>{
  const p=slicedLoops({layers:12,holeStarts:4,changeTool:true,open:false}),result=await buildPrintSurfaceLOD(p,{offsetEnvelope:false,useMeshoptimizer:false});
  assert.deepEqual(result.tools,[0,1]);assert.ok(result.stats.tracks>=5,'hole topology change and tool change terminate old skins');
  const tool=result.geometry.attributes.toolIndex,index=result.geometry.index;
  for(let i=0;i<index.count;i+=3){const ids=[index.getX(i),index.getX(i+1),index.getX(i+2)];assert.ok(ids.every(id=>tool.getX(id)===tool.getX(ids[0])),'no triangle crosses a filament boundary');}
  assert.ok(result.geometry.groups.every(group=>group.materialIndex===0||group.materialIndex===1));
});

test('Bambu-style subwidth seam is closed conservatively while genuine open strokes remain fallback',async()=>{
  const p=slicedLoops({layers:2,holes:false,open:true});
  const outer=[];for(let i=0;i<p.segmentCount;i++)if(p.features[i]===1)outer.push(i);
  p.positions[outer[3]*6+4]=.06;p.positions[outer[9]*6+4]=.06;
  const result=await buildPrintSurfaceLOD(p,{offsetEnvelope:false,useMeshoptimizer:false,seamToleranceMm:.1});
  assert.equal(result.stats.closedLoops,2);assert.equal(result.fallbackSourceIndices.length,4);
  assert.ok(result.stats.maxClosedSeamMm>.05&&result.stats.maxClosedSeamMm<.07);
});

test('meshoptimizer limits geometric error and keeps locked hole/color/corner boundaries, packet transfer roundtrips',async()=>{
  const p=slicedLoops({layers:30,holes:true,open:false,changeTool:true}),result=await buildPrintSurfaceLOD(p,{targetTriangles:12});
  assert.ok(result.stats.maximumMeshoptErrorMm<=.08*.3+1e-6);assert.ok(result.stats.triangles>=12,'target can be unattainable without violating locks');
  const packet=packPrintSurfaceLOD(result),transfer=printSurfaceLODTransferables(packet);
  assert.equal(transfer.length,new Set(transfer).size);assert.ok(transfer.every(buffer=>buffer instanceof ArrayBuffer));
  const roundtrip=unpackPrintSurfaceLOD(structuredClone(packet));
  assert.deepEqual([...roundtrip.geometry.index.array],[...result.geometry.index.array]);assert.deepEqual(roundtrip.geometry.groups,result.geometry.groups);
  assert.deepEqual([...roundtrip.geometry.attributes.color.array],[...result.geometry.attributes.color.array]);
  assert.deepEqual(roundtrip.bounds,result.bounds);
  assert.deepEqual([...roundtrip.fallbackGeometry.attributes.position.array],[...result.fallbackGeometry.attributes.position.array]);
});

test('uncertain/open source ribbons preserve exact width, physical height, endpoints, gaps and source/filament identities',()=>{
  const p=slicedLoops({layers:2,holes:false,open:true}),open=[];
  for(let i=0;i<p.segmentCount;i++)if(p.features[i]===1&&p.positions[i*6]>=20)open.push(i);
  const before=hash(p.positions),result=buildPrintFallbackRibbons(p,Uint32Array.from(open)),g=result.geometry;
  assert.equal(g.index.count,open.length*12);assert.equal(g.attributes.position.count,open.length*8);assert.equal(result.stats.maximumFallbackBaseDeviationMm,p.heights[open[0]]/2);
  const sourceId=g.attributes.sourceSegmentId,position=g.attributes.position,normal=g.attributes.normal,tool=g.attributes.toolIndex;
  for(let v=0;v<position.count;v++){
    const id=sourceId.getX(v),o=id*6,a=[p.positions[o],p.positions[o+1],p.positions[o+2]],b=[p.positions[o+3],p.positions[o+4],p.positions[o+5]],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy),offset=[position.getX(v)-a[0],position.getY(v)-a[1]];
    const along=(offset[0]*dx+offset[1]*dy)/length,lateral=(offset[0]*dy-offset[1]*dx)/length;
    assert.ok(Math.abs(along)<1e-5||Math.abs(along-length)<1e-5,'road does not extend beyond source endpoint');
    assert.ok(Math.abs(Math.abs(lateral)-p.widths[id]/2)<2e-6,'both sides use actual WIDTH');
    assert.ok(Math.abs(position.getZ(v)-a[2])<1e-6||Math.abs(position.getZ(v)-(a[2]-p.heights[id]))<1e-6,'actual deposited height, no guessed layer');
    assert.equal(tool.getX(v),p.tools[id]);assert.ok(Math.abs(Math.hypot(normal.getX(v),normal.getY(v),normal.getZ(v))-1)<2e-5);assert.equal(normal.getZ(v),0);
  }
  for(let i=0;i<g.index.count;i+=3){const ids=[g.index.getX(i),g.index.getX(i+1),g.index.getX(i+2)];assert.ok(ids.every(vertex=>sourceId.getX(vertex)===sourceId.getX(ids[0])),'no triangle joins different source roads or bridges a gap');}
  assert.equal(hash(p.positions),before);assert.equal(g.userData.sourcePathsUnmodified,true);
});

test('invalid settings and cancellation fail explicitly rather than silently returning partial fake skin',async()=>{
  const p=slicedLoops({layers:2});await assert.rejects(buildPrintSurfaceLOD(p,{maxDeviationMm:2}),/误差/);
  const abort=new AbortController();abort.abort();await assert.rejects(buildPrintSurfaceLOD(p,{signal:abort.signal}),error=>error.name==='AbortError');
});
