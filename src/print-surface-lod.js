import * as THREE from '../node_modules/three/build/three.module.js';
import { MeshoptSimplifier } from '../node_modules/three/examples/jsm/libs/meshopt_simplifier.module.js';

// This module reconstructs a display surface from deposited outer-wall loops.
// It does not recover missing CAD or alter the original G-code. Uncertain/open
// paths are returned for the existing exact-path renderer rather than bridged.
const OUTER=new Set([1,16]);
const sq=(x,y)=>x*x+y*y;
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const area=points=>points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0)*.5;
const bounds2=points=>{const min=[Infinity,Infinity],max=[-Infinity,-Infinity];for(const p of points)for(let i=0;i<2;i++){min[i]=Math.min(min[i],p[i]);max[i]=Math.max(max[i],p[i]);}return {min,max,centre:[(min[0]+max[0])*.5,(min[1]+max[1])*.5]};};

function segmentError(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],length=sq(dx,dy),t=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;return sq(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t);}

export function ringIsSimple(points){
  if(points.length<3||Math.abs(area(points))<1e-8)return false;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];if(dist(a,b)<1e-7)return false;
    for(let j=i+2;j<points.length;j++){
      if(i===0&&j===points.length-1)continue;
      const c=points[j],d=points[(j+1)%points.length];
      if(Math.max(a[0],b[0])<Math.min(c[0],d[0])-1e-8||Math.max(c[0],d[0])<Math.min(a[0],b[0])-1e-8||Math.max(a[1],b[1])<Math.min(c[1],d[1])-1e-8||Math.max(c[1],d[1])<Math.min(a[1],b[1])-1e-8)continue;
      const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
      if(abC*abD<=1e-14&&cdA*cdB<=1e-14)return false;
    }
  }
  return true;
}

function inside(p,polygon){let result=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
  const a=polygon[i],b=polygon[j];if(segmentError(p,a,b)<1e-14)return true;
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
}return result;}

function sharp(points,index,angle){const n=points.length,p=points[index],a=points[(index+n-1)%n],b=points[(index+1)%n],ux=p[0]-a[0],uy=p[1]-a[1],vx=b[0]-p[0],vy=b[1]-p[1];return (ux*vx+uy*vy)/Math.max(1e-20,Math.hypot(ux,uy)*Math.hypot(vx,vy))<Math.cos(angle);}

/** Closed Douglas-Peucker between locked corners; returns original point IDs.
 * It never caps a hole, removes a material boundary or joins unrelated runs. */
export function simplifyClosedRing(points,{errorMm=.03,cornerAngle=25*Math.PI/180}={}){
  if(!Number.isFinite(errorMm)||errorMm<0||!ringIsSimple(points))return null;
  const n=points.length,locks=new Uint8Array(n),keep=new Uint8Array(n);let anchor=0;
  for(let i=0;i<n;i++){if(points[i][0]<points[anchor][0]||(points[i][0]===points[anchor][0]&&points[i][1]<points[anchor][1]))anchor=i;if(sharp(points,i,cornerAngle))locks[i]=1;}
  locks[anchor]=1;let opposite=anchor,best=0;for(let i=0;i<n;i++){const d=dist(points[i],points[anchor]);if(d>best){best=d;opposite=i;}}locks[opposite]=1;
  const anchors=[];for(let i=0;i<n;i++)if(locks[i])anchors.push(i);
  for(let j=0;j<anchors.length;j++){
    const first=anchors[j],last=anchors[(j+1)%anchors.length],count=(last-first+n)%n,stack=[[0,count]];keep[first]=keep[last]=1;
    while(stack.length){const[a,b]=stack.pop();let max=errorMm*errorMm,index=-1;for(let k=a+1;k<b;k++){const e=segmentError(points[(first+k)%n],points[(first+a)%n],points[(first+b)%n]);if(e>max){max=e;index=k;}}
      if(index>=0){keep[(first+index)%n]=1;stack.push([a,index],[index,b]);}}
  }
  let ids=[];for(let i=0;i<n;i++)if(keep[i])ids.push(i);if(ids.length<3)return null;
  let result=ids.map(i=>points[i].slice());if(area(result)<0){result.reverse();ids.reverse();}
  let start=0;for(let i=1;i<result.length;i++)if(result[i][0]<result[start][0]||(result[i][0]===result[start][0]&&result[i][1]<result[start][1]))start=i;
  result=result.slice(start).concat(result.slice(0,start));ids=ids.slice(start).concat(ids.slice(0,start));
  if(!ringIsSimple(result))return null;
  return {points:result,sourcePointIndices:Uint32Array.from(ids),corners:Uint8Array.from(ids,i=>Number(sharp(points,i,cornerAngle)))};
}

function offsetRing(points,width,depth){
  const direction=depth%2?-1:1,output=[];
  for(let i=0;i<points.length;i++){
    const p=points[i],a=points[(i+points.length-1)%points.length],b=points[(i+1)%points.length];
    const al=dist(a,p),bl=dist(p,b),na=[direction*(p[1]-a[1])/al,-direction*(p[0]-a[0])/al],nb=[direction*(b[1]-p[1])/bl,-direction*(b[0]-p[0])/bl];
    const sx=na[0]+nb[0],sy=na[1]+nb[1],den=sx*nb[0]+sy*nb[1];
    if(den<.1)return null;
    const scale=width*.5/den;if(Math.hypot(sx*scale,sy*scale)>width*1.5)return null;
    output.push([p[0]+sx*scale,p[1]+sy*scale]);
  }
  return ringIsSimple(output)?output:null;
}

function validateParsed(p){for(const key of['positions','features','tools','widths','heights','strokes','layers','layerOffsets','layerSegments','layerHeights'])if(!ArrayBuffer.isView(p?.[key]))throw new TypeError(`连续表面缺少真实切片 ${key}。`);if(p.positions.length!==p.segmentCount*6||p.layerSegments.length!==p.segmentCount)throw new TypeError('真实切片数据不完整。');}

function extractContours(p,options,progress){
  const layers=Array.from({length:p.layerHeights.length},()=>[]),rejected=[];let loops=0,pointsBefore=0,pointsAfter=0,seamMax=0;
  for(let layer=0;layer<layers.length;layer++){
    const runs=new Map();
    for(let cursor=p.layerOffsets[layer];cursor<p.layerOffsets[layer+1];cursor++){const id=p.layerSegments[cursor];if(!OUTER.has(p.features[id]))continue;const key=p.strokes[id];let run=runs.get(key);if(!run){run=[];runs.set(key,run);}run.push(id);}
    for(const indices of runs.values()){
      const first=indices[0],last=indices[indices.length-1],from=first*6,to=last*6,tool=p.tools[first],width=p.widths[first],height=p.heights[first];
      const seam=Math.hypot(p.positions[from]-p.positions[to+3],p.positions[from+1]-p.positions[to+4]);
      let valid=indices.length>=3&&seam<=Math.min(options.seamToleranceMm,width*.5);const points=[];
      for(let j=0;j<indices.length;j++){const id=indices[j],o=id*6;points.push([p.positions[o],p.positions[o+1]]);
        valid&&=p.tools[id]===tool&&Math.abs(p.widths[id]-width)<.002&&Math.abs(p.heights[id]-height)<.002&&Math.abs(p.positions[o+2]-p.positions[o+5])<.001;
        if(j){const prev=indices[j-1]*6;valid&&=Math.hypot(p.positions[prev+3]-p.positions[o],p.positions[prev+4]-p.positions[o+1])<=.003;}}
      const simplified=valid?simplifyClosedRing(points,{errorMm:options.maxDeviationMm*.35,cornerAngle:options.cornerAngle}):null;
      if(!simplified){for(const id of indices)rejected.push(id);continue;}
      const loop={layer,tool,width,height,z:p.layerHeights[layer],indices:Uint32Array.from(indices),points:simplified.points,corners:simplified.corners,bounds:bounds2(simplified.points),depth:0,parent:null,children:0};
      layers[layer].push(loop);loops++;pointsBefore+=points.length;pointsAfter+=loop.points.length;seamMax=Math.max(seamMax,seam);
    }
    // Per-material nesting preserves holes while keeping distinct colored
    // regions independent; it cannot turn a colored nested solid into a void.
    const sorted=layers[layer].slice().sort((a,b)=>Math.abs(area(b.points))-Math.abs(area(a.points)));
    for(let i=0;i<sorted.length;i++){const loop=sorted[i];let parent=null;
      for(let j=0;j<i;j++){const outer=sorted[j];if(loop.tool!==outer.tool||loop.bounds.min.some((v,k)=>v<outer.bounds.min[k]-1e-7)||loop.bounds.max.some((v,k)=>v>outer.bounds.max[k]+1e-7))continue;
        if(loop.points.every(point=>inside(point,outer.points))&&(!parent||Math.abs(area(outer.points))<Math.abs(area(parent.points))))parent=outer;}
      loop.parent=parent;loop.depth=parent?parent.depth+1:0;if(parent)parent.children++;
    }
    for(const loop of layers[layer]){
      loop.surfacePoints=options.offsetEnvelope?offsetRing(loop.points,loop.width,loop.depth):loop.points.map(point=>point.slice());
      if(!loop.surfacePoints){loop.rejected=true;for(const id of loop.indices)rejected.push(id);}
    }
    progress('contours',layer+1,layers.length,{loops});
  }
  return {layers:layers.map(list=>list.filter(loop=>!loop.rejected)),rejected,stats:{closedLoops:loops,contourPointsBefore:pointsBefore,contourPointsAfter:pointsAfter,maxClosedSeamMm:seamMax}};
}

function alignLoop(previous,current,limit){
  if(previous.tool!==current.tool||previous.depth!==current.depth||previous.children!==current.children||previous.points.length!==current.points.length||Math.abs(previous.width-current.width)>.002)return null;
  if(dist(previous.bounds.centre,current.bounds.centre)>limit)return null;
  for(let i=0;i<2;i++)if(Math.abs((previous.bounds.max[i]-previous.bounds.min[i])-(current.bounds.max[i]-current.bounds.min[i]))>limit*2)return null;
  const n=current.points.length;let best=null;
  for(let shift=0;shift<n;shift++){let max=0,sum=0,valid=true;
    for(let i=0;i<n;i++){const j=(i+shift)%n;if(previous.corners[i]!==current.corners[j]){valid=false;break;}const d=dist(previous.surfacePoints[i],current.surfacePoints[j]);if(d>limit){valid=false;break;}max=Math.max(max,d);sum+=d*d;}
    if(valid&&(!best||sum<best.sum))best={shift,sum,max};}
  return best;
}

function buildTracks(layers,options,progress){
  const tracks=[];let previous=[];let links=0,ambiguous=0;
  for(let layer=0;layer<layers.length;layer++){
    const current=layers[layer],candidates=new Map(),uses=new Map();
    for(const loop of current){const matches=[];for(const prior of previous){const aligned=alignLoop(prior,loop,options.maxMatchDistanceMm);if(aligned)matches.push({prior,...aligned});}candidates.set(loop,matches);for(const match of matches)uses.set(match.prior,(uses.get(match.prior)||0)+1);}
    for(const loop of current){const matches=candidates.get(loop);if(matches.length===1&&uses.get(matches[0].prior)===1){const match=matches[0],shift=match.shift;
        loop.points=loop.points.slice(shift).concat(loop.points.slice(0,shift));loop.surfacePoints=loop.surfacePoints.slice(shift).concat(loop.surfacePoints.slice(0,shift));loop.corners=Uint8Array.from([...loop.corners.slice(shift),...loop.corners.slice(0,shift)]);
        loop.track=match.prior.track;loop.track.rings.push(loop);links++;
      }else{if(matches.length>1)ambiguous++;const track={tool:loop.tool,depth:loop.depth,rings:[loop]};loop.track=track;tracks.push(track);}}
    previous=current;progress('tracks',layer+1,layers.length,{tracks:tracks.length,links});
  }
  return {tracks,stats:{tracks:tracks.length,matchedLayerLinks:links,ambiguousLayerMatches:ambiguous}};
}

function retainedRings(rings,error){
  if(rings.length<=2)return rings;const keep=new Uint8Array(rings.length),stack=[[0,rings.length-1]];keep[0]=keep[rings.length-1]=1;
  while(stack.length){const[a,b]=stack.pop();let best=error,index=-1;const za=rings[a].z,span=rings[b].z-za;
    for(let i=a+1;i<b;i++){const t=(rings[i].z-za)/span;for(let v=0;v<rings[i].surfacePoints.length;v++){const pa=rings[a].surfacePoints[v],pb=rings[b].surfacePoints[v],p=rings[i].surfacePoints[v],e=Math.hypot(p[0]-pa[0]-(pb[0]-pa[0])*t,p[1]-pa[1]-(pb[1]-pa[1])*t);if(e>best){best=e;index=i;}}}
    if(index>=0){keep[index]=1;stack.push([a,index],[index,b]);}}
  return rings.filter((_,i)=>keep[i]);
}

function generateMesh(p,tracks,options,progress){
  const positions=[],colors=[],toolIndices=[],locks=[],triangles=new Map(),covered=new Uint8Array(p.segmentCount);let retained=0;
  for(let id=0;id<tracks.length;id++){
    const track=tracks[id],selected=retainedRings(track.rings,options.maxDeviationMm*.35),first=track.rings[0];
    const rows=[{...first,z:first.z-first.height},...selected],n=first.points.length,base=positions.length/3;
    const color=new THREE.Color(p.toolColors?.[track.tool]||'#b7bec8');
    for(let row=0;row<rows.length;row++)for(let v=0;v<n;v++){positions.push(rows[row].surfacePoints[v][0],rows[row].surfacePoints[v][1],rows[row].z);colors.push(color.r,color.g,color.b);toolIndices.push(track.tool);locks.push(row===0||row===rows.length-1||rows[row].corners[v]?1:0);}
    let indices=triangles.get(track.tool);if(!indices){indices=[];triangles.set(track.tool,indices);}
    for(let row=0;row<rows.length-1;row++)for(let v=0;v<n;v++){const next=(v+1)%n,a=base+row*n+v,b=base+row*n+next,c=base+(row+1)*n+v,d=base+(row+1)*n+next;
      if(track.depth%2)indices.push(a,c,b,b,c,d);else indices.push(a,b,c,b,d,c);}
    for(const ring of track.rings)for(const segment of ring.indices)covered[segment]=1;
    retained+=selected.length;progress('mesh',id+1,tracks.length,{retainedRings:retained});
  }
  return {positions:Float32Array.from(positions),colors:Float32Array.from(colors),toolIndices:Uint16Array.from(toolIndices),locks:Uint8Array.from(locks),triangles,covered,retained};
}

/** Flat historical sides for uncertain/open contours. Each original road is
 * handled independently, so this cannot bridge a door, join a different
 * stroke, seal an unknown loop or smear a filament boundary. The missing
 * microscopic rounded shoulder/end cap is explicitly bounded/approximate. */
export function buildPrintFallbackRibbons(parsed,sourceIndices,{onProgress=()=>{}}={}){
  const byTool=new Map();for(const id of sourceIndices){if(!OUTER.has(parsed.features[id]))throw new TypeError('平侧面仅支持真实外墙/悬垂外墙。');const tool=parsed.tools[id];let list=byTool.get(tool);if(!list){list=[];byTool.set(tool,list);}list.push(id);}
  const tools=[...byTool.keys()].sort((a,b)=>a-b),count=sourceIndices.length,vertices=count*8;
  const positions=new Float32Array(vertices*3),normals=new Int16Array(vertices*3),colors=new Uint16Array(vertices*3),toolIndex=new Uint16Array(vertices),sourceSegmentId=new Uint32Array(vertices),indices=new Uint32Array(count*12),groups=[];
  let road=0,maxHalfHeight=0,maxWidth=0;
  for(let slot=0;slot<tools.length;slot++){
    const tool=tools[slot],color=new THREE.Color(parsed.toolColors?.[tool]||'#b7bec8'),rgb=color.toArray().map(value=>Math.round(THREE.MathUtils.clamp(value,0,1)*65535)),groupStart=road*12;
    for(const id of byTool.get(tool)){
      const o=id*6,ax=parsed.positions[o],ay=parsed.positions[o+1],az=parsed.positions[o+2],bx=parsed.positions[o+3],by=parsed.positions[o+4],bz=parsed.positions[o+5],dx=bx-ax,dy=by-ay,length=Math.hypot(dx,dy),width=parsed.widths[id],height=parsed.heights[id];
      if(!(length>0)||!(width>0)||!(height>0))throw new TypeError('真实外墙挤出尺寸无效，不能省略。');
      const nx=dy/length,ny=-dx/length,base=road*8;
      for(let side=0;side<2;side++){
        const sign=side===0?1:-1,sx=nx*width*.5*sign,sy=ny*width*.5*sign,normalX=Math.round(nx*sign*32767),normalY=Math.round(ny*sign*32767);
        for(let corner=0;corner<4;corner++){const vertex=base+side*4+corner,target=vertex*3,atEnd=corner%2===1;
          positions[target]=(atEnd?bx:ax)+sx;positions[target+1]=(atEnd?by:ay)+sy;positions[target+2]=(atEnd?bz:az)-(corner<2?height:0);
          normals[target]=normalX;normals[target+1]=normalY;colors[target]=rgb[0];colors[target+1]=rgb[1];colors[target+2]=rgb[2];toolIndex[vertex]=tool;sourceSegmentId[vertex]=id;}
        const a=base+side*4,b=a+1,c=a+2,d=a+3,at=road*12+side*6;
        indices.set(sign>0?[a,b,c,b,d,c]:[a,c,b,b,c,d],at);
      }
      maxHalfHeight=Math.max(maxHalfHeight,height*.5);maxWidth=Math.max(maxWidth,width);road++;
    }
    groups.push({start:groupStart,count:road*12-groupStart,materialIndex:slot});onProgress({phase:'fallback-ribbons',completed:slot+1,total:tools.length});
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.BufferAttribute(normals,3,true));geometry.setAttribute('color',new THREE.BufferAttribute(colors,3,true));geometry.setAttribute('toolIndex',new THREE.BufferAttribute(toolIndex,1));geometry.setAttribute('sourceSegmentId',new THREE.BufferAttribute(sourceSegmentId,1));geometry.setIndex(new THREE.BufferAttribute(indices,1));for(const group of groups)geometry.addGroup(group.start,group.count,group.materialIndex);geometry.computeBoundingBox();geometry.computeBoundingSphere();
  geometry.userData={printSurfaceLODFallback:true,printerCoordinates:'mm-z-up',sourcePathsUnmodified:true,displayOnly:true,sourceEnvelopeApproximate:true,sourceSegments:count,sideTriangles:count*4,maximumBaseDeviationMm:maxHalfHeight,maximumWidthMm:maxWidth,tools,limitations:['flat historical side envelope; rounded shoulders and microscopic end caps omitted','only use while full layer height and endpoint cap project below the selected screen error','no top/bottom plane or fill inferred; original top/bridge/current-layer renderer remains responsible']};
  return {geometry,tools,stats:{fallbackRibbonSegments:count,fallbackRibbonTriangles:count*4,maximumFallbackBaseDeviationMm:maxHalfHeight,normalQuantizationMaximum:1/32767,colorQuantizationMaximum:1/65535}};
}

/** Angle-aware normals with locked creases. Vertices are split only for
 * shading; continuous skin topology / face positions are not simplified here. */
function creaseNormals(geometry,angle){
  const p=geometry.attributes.position,index=geometry.index.array,n=p.count,faces=new Float64Array(index.length),incident=Array.from({length:n},()=>[]);
  for(let f=0;f<index.length;f+=3){const a=index[f]*3,b=index[f+1]*3,c=index[f+2]*3,ab=[p.array[b]-p.array[a],p.array[b+1]-p.array[a+1],p.array[b+2]-p.array[a+2]],ac=[p.array[c]-p.array[a],p.array[c+1]-p.array[a+1],p.array[c+2]-p.array[a+2]],normal=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],length=Math.hypot(...normal);for(let k=0;k<3;k++){faces[f+k]=length?normal[k]/length:0;incident[index[f+k]].push(f+k);}}
  const attrs=Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,Array.from(a.array)])),normals=Array(n*3).fill(0),result=new Uint32Array(index.length),cos=Math.cos(angle);
  for(let vertex=0;vertex<n;vertex++){const clusters=[];
    for(const corner of incident[vertex]){const face=corner-corner%3,normal=[faces[face],faces[face+1],faces[face+2]];let cluster=clusters.find(c=>c.reference.reduce((sum,value,i)=>sum+value*normal[i],0)>=cos);
      if(!cluster){const id=clusters.length===0?vertex:attrs.position.length/3;cluster={id,reference:normal,sum:[0,0,0]};clusters.push(cluster);if(id!==vertex){for(const[name,a]of Object.entries(geometry.attributes))for(let k=0;k<a.itemSize;k++)attrs[name].push(a.array[vertex*a.itemSize+k]);normals.push(0,0,0);}}
      for(let k=0;k<3;k++)cluster.sum[k]+=normal[k];result[corner]=cluster.id;
    }
    for(const c of clusters){const length=Math.hypot(...c.sum)||1;for(let k=0;k<3;k++)normals[c.id*3+k]=c.sum[k]/length;}
  }
  for(const[name,a]of Object.entries(geometry.attributes))geometry.setAttribute(name,new THREE.BufferAttribute(new a.array.constructor(attrs[name]),a.itemSize,a.normalized));
  geometry.setIndex(new THREE.BufferAttribute(result,1));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));return geometry;
}

/** Build only historical outer-wall skin. Tops/bottoms/bridges/gaps and the
 * most recent real layers belong to the existing exact/mipmapped path renderer. */
export async function buildPrintSurfaceLOD(parsed,settings={}){
  validateParsed(parsed);const started=performance.now();
  const options={maxDeviationMm:.08,seamToleranceMm:.1,maxMatchDistanceMm:.18,targetTriangles:150000,cornerAngle:25*Math.PI/180,creaseAngle:50*Math.PI/180,offsetEnvelope:true,useMeshoptimizer:true,...settings};
  if(!Number.isFinite(options.maxDeviationMm)||options.maxDeviationMm<=0||options.maxDeviationMm>.5||!Number.isFinite(options.seamToleranceMm)||options.seamToleranceMm<0||!Number.isFinite(options.maxMatchDistanceMm)||options.maxMatchDistanceMm<=0||!Number.isInteger(options.targetTriangles)||options.targetTriangles<12)throw new TypeError('连续表面误差设置无效。');
  options.maxMatchDistanceMm=Math.min(options.maxMatchDistanceMm,options.maxDeviationMm*2);
  const onProgress=settings.onProgress||(()=>{});let lastPhase=null,lastProgressTime=-Infinity;
  const progress=(phase,completed,total,extra={})=>{
    if(settings.signal?.aborted)throw new DOMException('Aborted','AbortError');
    const now=performance.now();
    // Worker cancellation is checked every unit, but thousands of postMessage
    // progress events must not recreate the main-thread import freeze.
    if(phase!==lastPhase||completed===total||now-lastProgressTime>=40){lastPhase=phase;lastProgressTime=now;onProgress({phase,completed,total,...extra});}
  };
  const extracted=extractContours(parsed,options,progress),matched=buildTracks(extracted.layers,options,progress),mesh=generateMesh(parsed,matched.tracks,options,progress);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(mesh.positions,3));geometry.setAttribute('color',new THREE.BufferAttribute(mesh.colors,3));geometry.setAttribute('toolIndex',new THREE.BufferAttribute(mesh.toolIndices,1));
  const tools=[...mesh.triangles.keys()].sort((a,b)=>a-b),originalTriangles=[...mesh.triangles.values()].reduce((sum,list)=>sum+list.length/3,0);let maximumMeshoptErrorMm=0;const final=[];
  if(options.useMeshoptimizer&&MeshoptSimplifier.supported)await MeshoptSimplifier.ready;
  for(let slot=0;slot<tools.length;slot++){
    const tool=tools[slot],original=Uint32Array.from(mesh.triangles.get(tool));let indices=original;
    if(options.useMeshoptimizer&&MeshoptSimplifier.supported&&original.length>30&&originalTriangles>options.targetTriangles){
      const target=Math.max(3,Math.floor(options.targetTriangles*(original.length/3)/originalTriangles)*3);
      const result=MeshoptSimplifier.simplifyWithAttributes(original,mesh.positions,3,mesh.colors,3,[4,4,4],mesh.locks,target,options.maxDeviationMm*.3,['LockBorder','ErrorAbsolute']);
      indices=result[0];maximumMeshoptErrorMm=Math.max(maximumMeshoptErrorMm,result[1]);
    }
    geometry.addGroup(final.length,indices.length,slot);for(const index of indices)final.push(index);progress('simplify',slot+1,tools.length,{triangles:final.length/3});
  }
  geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(final),1));progress('normals',0,1);creaseNormals(geometry,options.creaseAngle);progress('normals',1,1);geometry.computeBoundingBox();geometry.computeBoundingSphere();
  const fallback=[];let coveredOuterSegments=0,sourceOuterSegments=0;for(let i=0;i<parsed.segmentCount;i++)if(OUTER.has(parsed.features[i])){sourceOuterSegments++;if(mesh.covered[i])coveredOuterSegments++;else fallback.push(i);}
  const fallbackSourceIndices=Uint32Array.from(fallback),ribbons=buildPrintFallbackRibbons(parsed,fallbackSourceIndices,{onProgress:event=>progress(event.phase,event.completed,event.total)});
  const stats={schemaVersion:1,source:'sliced-gcode-display-skin',sourceSegmentCount:parsed.segmentCount,sourceOuterSegments,coveredOuterSegments,fallbackOuterSegments:fallback.length,...extracted.stats,...matched.stats,...ribbons.stats,retainedRings:mesh.retained,originalSkinTriangles:originalTriangles,triangles:geometry.index.count/3,vertices:geometry.attributes.position.count,totalDisplayTriangles:geometry.index.count/3+ribbons.stats.fallbackRibbonTriangles,totalDisplayVertices:geometry.attributes.position.count+ribbons.geometry.attributes.position.count,targetTriangles:options.targetTriangles,targetReached:geometry.index.count/3<=options.targetTriangles,maximumMeshoptErrorMm,maxDeviationMm:options.maxDeviationMm,maxMatchDistanceMm:options.maxMatchDistanceMm,sourcePathsUnmodified:true,reSliced:false,sourceEnvelopeApproximate:true,holesProtected:true,colorBoundariesSeparated:true,cornerAngleDegrees:options.cornerAngle*180/Math.PI,seconds:(performance.now()-started)/1000};
  geometry.userData={printSurfaceLOD:true,printerCoordinates:'mm-z-up',sourcePathsUnmodified:true,displayOnly:true,sourceEnvelopeApproximate:true,displayErrorMm:options.maxDeviationMm,stats};
  const bounds=geometry.boundingBox.clone().union(ribbons.geometry.boundingBox);
  const result={geometry,fallbackGeometry:ribbons.geometry,fallbackTools:ribbons.tools,coveredSegmentMask:mesh.covered,fallbackSourceIndices,tools,stats,bounds:bounds.isEmpty()?{min:[0,0,0],max:[0,0,0]}:{min:bounds.min.toArray(),max:bounds.max.toArray()}};progress('complete',1,1,stats);return result;
}

function packGeometry(geometry){return {attributes:Object.fromEntries(Object.entries(geometry.attributes).map(([name,a])=>[name,{array:a.array,itemSize:a.itemSize,normalized:a.normalized}])),index:geometry.index.array,groups:geometry.groups.map(group=>({...group})),userData:{...geometry.userData}};}

export function packPrintSurfaceLOD(result){
  return {schemaVersion:1,...packGeometry(result.geometry),fallbackGeometry:result.fallbackGeometry?packGeometry(result.fallbackGeometry):null,fallbackTools:result.fallbackTools||[],coveredSegmentMask:result.coveredSegmentMask,fallbackSourceIndices:result.fallbackSourceIndices,tools:[...result.tools],stats:{...result.stats},bounds:result.bounds};
}

export function printSurfaceLODTransferables(packet){return [...new Set([...Object.values(packet.attributes).map(a=>a.array.buffer),packet.index.buffer,...(packet.fallbackGeometry?[...Object.values(packet.fallbackGeometry.attributes).map(a=>a.array.buffer),packet.fallbackGeometry.index.buffer]:[]),packet.coveredSegmentMask.buffer,packet.fallbackSourceIndices.buffer])];}

function unpackGeometry(packet){const geometry=new THREE.BufferGeometry();for(const[name,a]of Object.entries(packet.attributes))geometry.setAttribute(name,new THREE.BufferAttribute(a.array,a.itemSize,a.normalized));geometry.setIndex(new THREE.BufferAttribute(packet.index,1));for(const group of packet.groups)geometry.addGroup(group.start,group.count,group.materialIndex);geometry.userData={...packet.userData};geometry.computeBoundingBox();geometry.computeBoundingSphere();return geometry;}

export function unpackPrintSurfaceLOD(packet){
  if(packet?.schemaVersion!==1||!packet.attributes?.position||!ArrayBuffer.isView(packet.index))throw new TypeError('连续表面缓存无效。');
  return {...packet,geometry:unpackGeometry(packet),fallbackGeometry:packet.fallbackGeometry?unpackGeometry(packet.fallbackGeometry):null};
}
