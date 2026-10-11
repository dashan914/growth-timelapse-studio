export const CAMERA_METRIC_REVISION = 1;

const components = value => {
  const result = Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : value && [value.x,value.y,value.z];
  return result?.length===3 && result.every(Number.isFinite) ? result : null;
};
const close = (a,b) => Math.hypot(...a.map((value,index)=>value-b[index])) <= Math.max(1,Math.hypot(...b))*1e-6;
const direction = value => {
  const v=components(value),length=v&&Math.hypot(...v);
  return length>1e-12?v.map(component=>component/length):null;
};

/** Only correct a numerically identified legacy calibrated camera. A manually
 * changed orbit/lens must survive: an absent revision alone is not evidence
 * that its pose came from the former display-scale/bed coupling. */
export function migratePhotoCameraMetric(camera,{revision=0,modelScale=1,calibratedCamera=null}={}){
  const unchanged={camera,migrated:false};
  const scale=Number(modelScale);
  if(!camera||Number(revision)>=CAMERA_METRIC_REVISION||!calibratedCamera||!Number.isFinite(scale)||scale<=0||Math.abs(scale-1)<1e-6)return unchanged;
  const position=components(camera.position),target=components(camera.target);
  const expectedPosition=components(calibratedCamera.position),expectedTarget=components(calibratedCamera.target);
  const up=direction(camera.up),expectedUp=direction(calibratedCamera.up);
  if(!position||!target||!expectedPosition||!expectedTarget||!up||!expectedUp||!Number.isFinite(camera.fov)||!Number.isFinite(calibratedCamera.fov)||
    Math.abs(camera.fov-calibratedCamera.fov)>1e-5||!close(up,expectedUp))return unchanged;
  if(!close(position,expectedPosition.map(value=>value*scale))||!close(target,expectedTarget.map(value=>value*scale)))return unchanged;
  return {camera:{...camera,position:position.map(value=>value/scale),target:target.map(value=>value/scale)},migrated:true};
}
