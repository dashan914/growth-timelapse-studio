import {BACKGROUND_PRESETS} from './background-presets.js';

const poseDefaults = Object.freeze({modelOffsetX:0,modelOffsetY:0,modelOffsetZ:0,
  modelRotationX:0,modelRotationY:0,modelRotationZ:0,modelScale:1});
const own = (value,key) => value && Object.hasOwn(value,key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const key = value => typeof value === 'string' ? value : '';

/** A marker belongs to one source model and one preset, never to a pose alone. */
export function normalizePresetPlacementState(value) {
  if (!object(value) || !Object.hasOwn(BACKGROUND_PRESETS,value.preset)
    || !Number.isInteger(value.revision) || value.revision < 1
    || typeof value.modelSourceKey !== 'string' || !value.modelSourceKey.trim()) return null;
  return {preset:value.preset,revision:value.revision,modelSourceKey:value.modelSourceKey};
}

function cameraSnapshot(value) {
  const vector = values => Array.isArray(values) && values.length === 3 && values.every(number);
  if (!object(value) || !['position','target','up'].every(field => vector(value[field]))
    || Math.hypot(...value.up) <= 1e-12 || !number(value.fov) || value.fov <= 0 || value.fov >= 180
    || !object(value.imageSize) || !['width','height'].every(field => number(value.imageSize[field]) && value.imageSize[field] > 0)) return null;
  return {position:[...value.position],target:[...value.target],up:[...value.up],fov:value.fov,
    imageSize:{width:value.imageSize.width,height:value.imageSize.height}};
}

function snapshot(record,source,preset,modelSourceKey) {
  if (!object(record)) return null;
  const hasMarker = record.posePlacement !== undefined && record.posePlacement !== null;
  const marker = normalizePresetPlacementState(record.posePlacement);
  if (hasMarker && !marker) return null;
  const background = marker?.preset ?? (own(record,'backgroundPreset') ? key(record.backgroundPreset) : null);
  const model = marker?.modelSourceKey || key(record.modelSourceKey) || key(record.sliceCache?.sourceSha256);
  if (background !== null && background !== preset || model && model !== modelSourceKey) return null;
  // Conflicting metadata must not make an unrelated pose appear current.
  if (marker && (own(record,'backgroundPreset') && key(record.backgroundPreset) !== marker.preset
    || record.modelSourceKey && record.modelSourceKey !== marker.modelSourceKey
    || record.sliceCache?.sourceSha256 && record.sliceCache.sourceSha256 !== marker.modelSourceKey)) return null;
  const input = object(record.pose) ? record.pose : own(record,'model-scale')
    ? {modelScale:record['model-scale'],modelOffsetX:record['offset-x'],modelOffsetY:record['offset-y']} : null;
  if (!input) return null;
  const pose = {...poseDefaults};
  for (const field of Object.keys(pose)) {
    if (input[field] === undefined || input[field] === null) continue;
    const value = typeof input[field] === 'string' && input[field].trim() ? Number(input[field]) : input[field];
    if (!number(value) || field === 'modelScale' && value <= 0) return null;
    pose[field] = value;
  }
  if (!own(input,'modelScale') && !Object.keys(poseDefaults).some(field => own(input,field))) return null;
  const sourceKeys = [marker?.modelSourceKey,key(record.modelSourceKey),key(record.sliceCache?.sourceSha256)].filter(Boolean);
  const sourceMatches = sourceKeys.length > 0 && sourceKeys.every(value => value === modelSourceKey);
  const sourceSceneScale = sourceMatches && number(record.sourceSceneScale) && record.sourceSceneScale > 0 ? record.sourceSceneScale : null;
  const poseCamera = sourceMatches ? cameraSnapshot(record.poseCamera) : null;
  const cameraMetricRevision = sourceMatches && Number.isInteger(record.cameraMetricRevision) && record.cameraMetricRevision >= 0
    ? record.cameraMetricRevision : null;
  return {pose,posePlacement:marker,poseUpdatedAt:number(record.poseUpdatedAt) && record.poseUpdatedAt >= 0 ? record.poseUpdatedAt : 0,
    sourceSceneScale,poseCamera,cameraMetricRevision,source,bound:Boolean(model)};
}

/** Choose a whole pose/marker/timestamp/source-scale/camera record, never merge stores.
 * Saved millimetres-to-world scale is valid only for its explicitly identified
 * source; legacy unbound records never guess a scale from another snapshot.
 * Pass the project preset alongside its settings, since IndexedDB stores it
 * separately. A source-bound record outranks an ambiguous legacy local record;
 * equally bound records use the newest timestamp. Unbound legacy snapshots
 * fall back to the project that owns the restored source files.
 */
export function selectPresetPlacementSnapshot({local=null,project=null,preset='',modelSourceKey=''} = {}) {
  const candidates = [snapshot(local,'local',key(preset),key(modelSourceKey)),
    snapshot(project,'project',key(preset),key(modelSourceKey))].filter(Boolean);
  candidates.sort((a,b) => {
    if (a.bound !== b.bound) return Number(b.bound)-Number(a.bound);
    if (!a.bound) return Number(b.source==='project')-Number(a.source==='project');
    return b.poseUpdatedAt-a.poseUpdatedAt || (b.posePlacement?.revision || 0)-(a.posePlacement?.revision || 0)
      || Number(b.source==='project')-Number(a.source==='project');
  });
  if (!candidates.length) return null;
  const {bound,...selected} = candidates[0];
  return selected;
}

/** Only printer compositions receive this one-time default-size upgrade.
 * A current marker survives manual transforms, so reopening preserves them.
 */
export function needsPresetPlacementUpgrade({preset,revision=BACKGROUND_PRESETS[preset]?.placement?.revision,snapshot:savedSnapshot=null} = {}) {
  if (!Object.hasOwn(BACKGROUND_PRESETS,preset) || BACKGROUND_PRESETS[preset].kind !== 'printer'
    || !Number.isInteger(revision) || revision < 1) return false;
  const marker = normalizePresetPlacementState(savedSnapshot?.posePlacement);
  return !marker || marker.preset !== preset || marker.revision < revision;
}
