import test from 'node:test';
import assert from 'node:assert/strict';
import {BACKGROUND_PRESETS} from '../src/background-presets.js';
import {normalizePresetPlacementState,selectPresetPlacementSnapshot,needsPresetPlacementUpgrade} from '../src/preset-placement-state.js';

const modelSourceKey='model-a';
const preset='h2c',revision=BACKGROUND_PRESETS.h2c.placement.revision;
const marker=(id=preset,rev=revision,model=modelSourceKey)=>({preset:id,revision:rev,modelSourceKey:model});
const record=(scale,state=marker(),updated=100)=>({pose:{modelScale:scale,modelOffsetX:.2},posePlacement:state,poseUpdatedAt:updated});
const choose=(local,project,options={})=>selectPresetPlacementSnapshot({local,project,preset,modelSourceKey,...options});
const camera=(x=1)=>({position:[x,2,3],target:[0,1,0],up:[0,1,0],fov:36,imageSize:{width:4000,height:3000}});

test('markers validate source, preset and revision and do not share mutable state',()=>{
  const input=marker(),state=normalizePresetPlacementState(input);
  assert.deepEqual(state,input);assert.notEqual(state,input);
  for(const value of [null,[],{},marker('__proto__'),marker('constructor'),marker(preset,0),marker(preset,1.5),marker(preset,revision,''),marker(preset,revision,' ')]) {
    assert.equal(normalizePresetPlacementState(value),null);
  }
});

test('newest matching local snapshot keeps its pose and marker together against an old project',()=>{
  const local=record(.9,marker(),300),project=record(3,marker(preset,revision-1),100);
  local.sourceSceneScale=.08;project.sourceSceneScale=.04;
  const chosen=choose(local,project);
  assert.equal(chosen.source,'local');assert.equal(chosen.pose.modelScale,.9);
  assert.deepEqual(chosen.posePlacement,local.posePlacement);assert.equal(chosen.poseUpdatedAt,300);
  assert.equal(chosen.sourceSceneScale,.08);
  assert.equal(needsPresetPlacementUpgrade({preset,snapshot:chosen}),false);
  chosen.pose.modelScale=4;chosen.posePlacement.revision=99;
  assert.equal(local.pose.modelScale,.9);assert.equal(local.posePlacement.revision,revision);
});

test('a genuinely newer matching project wins over local, including a manual pose',()=>{
  const chosen=choose({...record(.9,marker(),100),sourceSceneScale:.08},{...record(1.25,marker(),300),sourceSceneScale:.04});
  assert.equal(chosen.source,'project');assert.equal(chosen.pose.modelScale,1.25);
  assert.equal(chosen.sourceSceneScale,.04);
  assert.equal(needsPresetPlacementUpgrade({preset,snapshot:chosen}),false);
});

test('matching newer legacy pose is not combined with a current marker from the other store',()=>{
  const legacy={pose:{modelScale:3},backgroundPreset:preset,modelSourceKey,poseUpdatedAt:500};
  const chosen=choose(record(.9,marker(),100),legacy);
  assert.equal(chosen.pose.modelScale,3);assert.equal(chosen.posePlacement,null);
  assert.equal(needsPresetPlacementUpgrade({preset,snapshot:chosen}),true);
});

test('snapshots from other models or backgrounds cannot overwrite this model',()=>{
  const valid=record(.9);
  for(const other of [record(3,marker('p1s'),900),record(3,marker(preset,revision,'model-b'),900),
    {pose:{modelScale:3},backgroundPreset:'p1s',poseUpdatedAt:900},
    {pose:{modelScale:3},backgroundPreset:preset,modelSourceKey:'model-b',poseUpdatedAt:900}]) {
    assert.equal(choose(other,valid).pose.modelScale,.9);
    assert.equal(choose(other,null),null);
  }
});

test('contradictory or malformed markers are rejected instead of treated as legacy',()=>{
  for(const other of [{...record(3),backgroundPreset:'p1s'},
    {...record(3),modelSourceKey:'model-b'}, {...record(3),sliceCache:{sourceSha256:'model-b'}},
    record(3,{preset,revision,modelSourceKey:''})]) {
    assert.equal(choose(other,null),null);
  }
});

test('legacy IndexedDB source ownership beats an ambiguous local pose',()=>{
  const project={pose:{modelScale:3},backgroundPreset:preset,sliceCache:{sourceSha256:modelSourceKey}};
  const local={pose:{modelScale:2},backgroundPreset:preset,poseUpdatedAt:1000};
  const chosen=choose(local,project);
  assert.equal(chosen.source,'project');assert.equal(chosen.posePlacement,null);
  assert.equal(needsPresetPlacementUpgrade({preset,snapshot:chosen}),true);
  assert.equal(choose({pose:{modelScale:2}},{pose:{modelScale:3}}).source,'project');
  assert.equal(choose({pose:{modelScale:2},poseUpdatedAt:1000},{pose:{modelScale:3},poseUpdatedAt:1}).source,'project');
});

test('old slider records are restored without inventing a marker',()=>{
  const chosen=choose({'model-scale':'2.5','offset-x':'0.4','offset-y':0},null);
  assert.equal(chosen.pose.modelScale,2.5);assert.equal(chosen.pose.modelOffsetX,.4);
  assert.equal(chosen.pose.modelRotationY,0);assert.equal(chosen.posePlacement,null);
  for(const pose of [{modelScale:NaN},{modelScale:-1},{modelOffsetX:Infinity},{}])assert.equal(choose({pose},null),null);
  assert.equal(choose({},null),null);
});

test('only old printer revisions need migration; current manual poses persist on repeated reopening',()=>{
  for(const id of ['h2c','p1s','a1']) {
    assert.equal(needsPresetPlacementUpgrade({preset:id,snapshot:null}),true);
    assert.equal(needsPresetPlacementUpgrade({preset:id,snapshot:{posePlacement:marker(id,revision-1)}}),true);
    const saved=record(.75,marker(id));
    const first=choose(saved,null,{preset:id}),second=choose(first,null,{preset:id});
    assert.equal(second.pose.modelScale,.75);
    assert.equal(needsPresetPlacementUpgrade({preset:id,snapshot:second}),false);
    assert.equal(needsPresetPlacementUpgrade({preset:id,snapshot:{posePlacement:marker(id,revision+1)}}),false);
  }
  for(const id of ['', 'custom','__proto__','pastel-rug','blue-grey','teal-room']) {
    assert.equal(needsPresetPlacementUpgrade({preset:id,snapshot:null}),false);
  }
});

test('custom backgrounds keep matching poses without forcing preset migration',()=>{
  const selected=choose({pose:{modelScale:1.2},backgroundPreset:null,modelSourceKey,poseUpdatedAt:200},
    {pose:{modelScale:1},backgroundPreset:null,modelSourceKey,poseUpdatedAt:100},{preset:''});
  assert.equal(selected.pose.modelScale,1.2);assert.equal(selected.posePlacement,null);
  assert.equal(needsPresetPlacementUpgrade({preset:'',snapshot:selected}),false);
});

test('source scene scale requires a positive finite number and a matching explicit source identity',()=>{
  const base={pose:{modelScale:1.2},backgroundPreset:preset,sourceSceneScale:.07};
  assert.equal(choose(base,null).sourceSceneScale,null,'unbound legacy records do not infer a physical scale');
  assert.equal(choose({...base,modelSourceKey},null).sourceSceneScale,.07);
  assert.equal(choose({...base,sliceCache:{sourceSha256:modelSourceKey}},null).sourceSceneScale,.07);
  assert.equal(choose({...base,posePlacement:marker()},null).sourceSceneScale,.07);
  for(const value of [undefined,null,0,-.01,NaN,Infinity,'0.07',{},[],true]){
    const chosen=choose({...record(1.2),sourceSceneScale:value},null);
    assert.equal(chosen.pose.modelScale,1.2);assert.equal(chosen.sourceSceneScale,null);
  }
});

test('a scale from the wrong source hash cannot enter the matching pose snapshot',()=>{
  const matching={pose:{modelScale:1.2},backgroundPreset:preset,modelSourceKey,poseUpdatedAt:100};
  for(const wrong of [{...record(3,marker(preset,revision,'model-b'),300),sourceSceneScale:2},
    {pose:{modelScale:3},backgroundPreset:preset,modelSourceKey:'model-b',sourceSceneScale:2,poseUpdatedAt:300},
    {pose:{modelScale:3},backgroundPreset:preset,sliceCache:{sourceSha256:'model-b'},sourceSceneScale:2,poseUpdatedAt:300}]){
    const chosen=choose(wrong,matching);
    assert.equal(chosen.pose.modelScale,1.2);assert.equal(chosen.sourceSceneScale,null);
  }
  const conflicting={...matching,sourceSceneScale:2,sliceCache:{sourceSha256:'model-b'}};
  assert.equal(choose(conflicting,null).sourceSceneScale,null,'contradictory provenance cannot authorize a physical scale');
});

test('a missing scale in the selected newer snapshot never borrows one from stale IndexedDB',()=>{
  const local=record(.9,marker(),300),project={...record(3,marker(preset,revision-1),100),sourceSceneScale:.04};
  const chosen=choose(local,project);
  assert.equal(chosen.source,'local');assert.equal(chosen.pose.modelScale,.9);
  assert.equal(chosen.posePlacement.revision,revision);assert.equal(chosen.sourceSceneScale,null);
});

test('pose, physical scene scale, camera and its metric revision come from the same newer record',()=>{
  const local={...record(.9,marker(),300),sourceSceneScale:.08,poseCamera:camera(7),cameraMetricRevision:2};
  const project={...record(3,marker(preset,revision-1),100),sourceSceneScale:.04,poseCamera:camera(1),cameraMetricRevision:1};
  const chosen=choose(local,project);
  assert.equal(chosen.source,'local');assert.equal(chosen.pose.modelScale,.9);assert.equal(chosen.sourceSceneScale,.08);
  assert.deepEqual(chosen.poseCamera,local.poseCamera);assert.equal(chosen.cameraMetricRevision,2);
  chosen.poseCamera.position[0]=100;chosen.poseCamera.target[0]=100;chosen.poseCamera.up[0]=100;chosen.poseCamera.imageSize.width=1;
  assert.equal(local.poseCamera.position[0],7);assert.equal(local.poseCamera.target[0],0);
  assert.equal(local.poseCamera.up[0],0);assert.equal(local.poseCamera.imageSize.width,4000);
  project.poseUpdatedAt=500;const newerProject=choose(local,project);
  assert.equal(newerProject.source,'project');assert.equal(newerProject.poseCamera.position[0],1);
  assert.equal(newerProject.cameraMetricRevision,1);assert.equal(newerProject.sourceSceneScale,.04);
});

test('invalid or unbound cameras are omitted without inventing a replacement from the other store',()=>{
  const valid=camera();
  for(const poseCamera of [null,{}, {...valid,position:[1,2]}, {...valid,target:[1,2,Infinity]},
    {...valid,up:[0,0,0]}, {...valid,fov:0}, {...valid,fov:180}, {...valid,fov:'36'},
    {...valid,imageSize:{width:NaN,height:3000}}, {...valid,imageSize:{width:4000,height:0}}]){
    const chosen=choose({...record(.9),poseCamera},null);
    assert.equal(chosen.pose.modelScale,.9);assert.equal(chosen.poseCamera,null);
  }
  const unbound={pose:{modelScale:.9},backgroundPreset:preset,poseCamera:valid,cameraMetricRevision:2};
  const chosen=choose(unbound,null);assert.equal(chosen.poseCamera,null);assert.equal(chosen.cameraMetricRevision,null);
  const newer=choose(record(.9,marker(),300),{...record(3,marker(),100),poseCamera:valid,cameraMetricRevision:1});
  assert.equal(newer.poseCamera,null);assert.equal(newer.cameraMetricRevision,null);
  const conflicting={pose:{modelScale:.9},backgroundPreset:preset,modelSourceKey,sliceCache:{sourceSha256:'other'},
    poseCamera:valid,cameraMetricRevision:2};
  const rejectedCamera=choose(conflicting,null);assert.equal(rejectedCamera.poseCamera,null);assert.equal(rejectedCamera.cameraMetricRevision,null);
});

test('a matching camera keeps only a valid metric revision from its own record',()=>{
  for(const value of [undefined,null,-1,1.5,'2',NaN,Infinity]){
    assert.equal(choose({...record(.9),poseCamera:camera(),cameraMetricRevision:value},null).cameraMetricRevision,null);
  }
  assert.equal(choose({...record(.9),poseCamera:camera(),cameraMetricRevision:0},null).cameraMetricRevision,0);
});
