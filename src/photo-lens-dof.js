/** Shared preview/offline physical lens contract. A photograph's EXIF is a lens
 * reference, not a measured focus distance or proof of recovered illumination.
 * World-unit conversion must come from the same metric scene/bed scale as HQ,
 * not from a changing growth slice or by cancelling the user's model display scale.
 */
export const PHOTO_LENS_DOF_REFERENCES = Object.freeze({
  'preset:h2c': Object.freeze({
    photoIdentity: 'preset:h2c', sourcePhoto: 'DSC04419.jpg / assets/backgrounds/h2c.jpg',
    cameraFormat: 'Sony full-frame', sourceSensorHeightMm: 24,
    focalLengthMm: 24, fNumber: 2.8, referenceStrength: 10, defaultFocusPercent: 40,
    focalSource: 'photo-exif-reference', apertureSource: 'photo-exif-reference',
    sensorSource: 'full-frame-format-reference', focusSource: 'complete-model-bounds-estimate',
  }),
});

// Matched by controlled rendered/photo comparisons for these exact assets.
// These are editable visual estimates; they are kept separate from EXIF facts.
export const PHOTO_LENS_DOF_ESTIMATES = Object.freeze({
  'preset:p1s': Object.freeze({photoIdentity:'preset:p1s',sourcePhoto:'DSC04422.jpg / assets/backgrounds/p1s.jpg',
    fNumber:4,referenceStrength:12,apertureSource:'visual-estimate',measured:false}),
  'preset:a1': Object.freeze({photoIdentity:'preset:a1',sourcePhoto:'DSC04420.jpg / assets/backgrounds/a1.jpg',
    fNumber:4,referenceStrength:16,apertureSource:'visual-estimate',measured:false}),
  // Generated background plates carry no recovered camera metadata. These
  // conservative virtual apertures keep the model readable; the teal room's
  // deeper baked bokeh allows slightly more model defocus than the studios.
  'preset:pastel-rug': Object.freeze({photoIdentity:'preset:pastel-rug',sourcePhoto:'assets/backgrounds/pastel-rug.png',
    fNumber:8,referenceStrength:14,apertureSource:'visual-estimate',measured:false}),
  'preset:blue-grey': Object.freeze({photoIdentity:'preset:blue-grey',sourcePhoto:'assets/backgrounds/blue-grey.png',
    fNumber:8,referenceStrength:10,apertureSource:'visual-estimate',measured:false}),
  'preset:teal-room': Object.freeze({photoIdentity:'preset:teal-room',sourcePhoto:'assets/backgrounds/teal-room.png',
    fNumber:5.6,referenceStrength:22,apertureSource:'visual-estimate',measured:false}),
});

function finite(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0) throw new TypeError(`${label}需要有效${positive ? '正' : ''}数。`);
  return value;
}
function percentage(value, label) {
  finite(value, label);
  if (value < 0 || value > 100) throw new RangeError(`${label}需要在 0–100 之间。`);
  return value;
}
function vector(value, count, label) {
  const values = value?.elements || (count === 3 && value && !Array.isArray(value) && !ArrayBuffer.isView(value) ? [value.x, value.y, value.z] : value);
  if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== count || Array.from(values).some(component => !Number.isFinite(component))) throw new TypeError(`${label}坐标无效。`);
  return values;
}

/** Exact asset identity is opt-in. Merely importing a photo named H2C, switching
 * backgrounds or keeping an old printer selection cannot inherit this EXIF. */
export function photoLensDofReference(photoIdentity) {
  return Object.hasOwn(PHOTO_LENS_DOF_REFERENCES, photoIdentity) ? { ...PHOTO_LENS_DOF_REFERENCES[photoIdentity] } : null;
}

export function photoLensDofEstimate(photoIdentity){
  return Object.hasOwn(PHOTO_LENS_DOF_ESTIMATES,photoIdentity)?{...PHOTO_LENS_DOF_ESTIMATES[photoIdentity]}:null;
}

/** Digital cover/crop changes the active sensor region, not the lens. P5 belongs
 * to the final (possibly shifted/cropped) projection. Sensor-fit remains vertical;
 * keeping P5 = 2*f/effectiveHeight preserves projection including off-centre shift.
 */
export function photoLensSensorRegion({ projectionMatrix, sourceSensorHeightMm = 24, sourceUV = null } = {}) {
  const matrix = vector(projectionMatrix, 16, '镜头投影');
  finite(sourceSensorHeightMm, '完整源传感器高度', { positive: true });
  if (matrix[0] <= 0 || matrix[5] <= 0 || Math.abs(matrix[11] + 1) > 1e-8 || Math.abs(matrix[15]) > 1e-8) throw new TypeError('需要完整的透视镜头投影。');
  const repeatY = sourceUV?.repeatY ?? 1;
  finite(repeatY, '源照片纵向裁剪范围', { positive: true });
  if (repeatY > 1) throw new RangeError('源照片纵向裁剪范围不能超过完整画面。');
  const effectiveSensorHeightMm = sourceSensorHeightMm * repeatY;
  const physicalFocalLengthMm = matrix[5] * effectiveSensorHeightMm / 2;
  return {
    sourceSensorHeightMm, sourceRegionHeightFraction: repeatY, effectiveSensorHeightMm,
    effectiveSensorWidthMm: effectiveSensorHeightMm * matrix[5] / matrix[0],
    physicalFocalLengthMm, focalSource: 'projection-and-source-sensor-region',
    sourceRegionSource: sourceUV ? 'explicit-source-uv' : 'full-source-height-assumption',
    projectionShift: [matrix[8], matrix[9]], sensorFit: 'VERTICAL',
  };
}

/** Optical circle-of-confusion DIAMETER on the sensor, all distances in mm.
 * This is a thin-lens approximation; no diffraction, lens aberration or sensor PSF.
 */
export function thinLensCoCDiameterMm({ focalLengthMm, fNumber, focusDistanceMm, depthMm } = {}) {
  finite(focalLengthMm, '镜头焦段', { positive: true });
  finite(fNumber, '镜头光圈', { positive: true });
  finite(focusDistanceMm, '焦点距离', { positive: true });
  if (focusDistanceMm <= focalLengthMm) throw new RangeError('焦点必须在镜头焦距之外。');
  if (depthMm !== Infinity) finite(depthMm, '镜头轴向深度', { positive: true });
  const defocus = depthMm === Infinity ? 1 : Math.abs(depthMm - focusDistanceMm) / depthMm;
  return focalLengthMm * focalLengthMm * defocus / (fNumber * (focusDistanceMm - focalLengthMm));
}

export function thinLensCoCDiameterPixels({ sensorHeightMm, imageHeightPx, ...optics } = {}) {
  finite(sensorHeightMm, '有效传感器高度', { positive: true });
  finite(imageHeightPx, '画面像素高度', { positive: true });
  return thinLensCoCDiameterMm(optics) * imageHeightPx / sensorHeightMm;
}

/** Use the COMPLETE model's camera-axis depth bounds. Do not supply a revealed
 * slice's bounds or support bounds; focus should not jump during growth or toggle.
 * worldToCamera is column-major, camera looks down -Z as in Three.js.
 */
export function focusFromCompleteModelBounds({ bounds, worldToCamera, worldToMm, focusPercent = 50, nearClipWorld = .0001 } = {}) {
  const low = vector(bounds?.min, 3, '完整模型最小范围'), high = vector(bounds?.max, 3, '完整模型最大范围');
  const camera = vector(worldToCamera, 16, '世界到镜头');
  finite(worldToMm, '场景单位到毫米', { positive: true });
  finite(nearClipWorld, '镜头近裁剪', { positive: true }); percentage(focusPercent, '焦点比例');
  if (low.some((value, index) => value > high[index])) throw new RangeError('完整模型范围无效。');
  let near = Infinity, far = -Infinity;
  for (const x of [low[0], high[0]]) for (const y of [low[1], high[1]]) for (const z of [low[2], high[2]]) {
    const depth = -(camera[2] * x + camera[6] * y + camera[10] * z + camera[14]);
    near = Math.min(near, depth); far = Math.max(far, depth);
  }
  if (far <= nearClipWorld) throw new RangeError('完整模型不在镜头前方，无法估计焦点。');
  near = Math.max(nearClipWorld, near);
  const focusDistanceWorld = near + (far - near) * focusPercent / 100;
  return { nearDepthWorld: near, farDepthWorld: far, focusDistanceWorld,
    focusDistanceMm: focusDistanceWorld * worldToMm,
    focusSource: 'complete-model-bounds-estimate', focusMeasured: false };
}

/** At known-reference strength, preserve EXIF f/N. Strength controls virtual
 * aperture area (N ∝ 1/sqrt(strength)), not a claim about the recorded photograph.
 * Unknown images preserve the current visual legacy aperture estimate.
 */
export function photoLensAperture({ strength = 35, enabled = false, reference = null, estimate = null } = {}) {
  percentage(strength, '景深强度');
  if (typeof enabled !== 'boolean') throw new TypeError('景深开关必须为布尔值。');
  if (!enabled || strength === 0) return { enabled: false, fNumber: null, apertureSource: 'disabled', reference: reference && { ...reference }, estimate:estimate&&{...estimate} };
  if (reference) {
    finite(reference.fNumber, '照片参考光圈', { positive: true });
    finite(reference.referenceStrength, '照片参考强度', { positive: true });
    const fNumber = Math.min(64, Math.max(.7, reference.fNumber * Math.sqrt(reference.referenceStrength / strength)));
    return { enabled: true, fNumber,
      apertureSource: strength === reference.referenceStrength ? 'photo-exif-reference' : 'virtual-adjustment-from-photo-reference',
      reference: { ...reference }, virtualAdjustment: strength !== reference.referenceStrength };
  }
  if(estimate){
    finite(estimate.fNumber,'估计光圈',{positive:true});finite(estimate.referenceStrength,'估计参考强度',{positive:true});
    return {enabled:true,fNumber:Math.min(64,Math.max(.7,estimate.fNumber*Math.sqrt(estimate.referenceStrength/strength))),
      apertureSource:strength===estimate.referenceStrength?'visual-estimate':'virtual-adjustment-from-visual-estimate',
      reference:null,estimate:{...estimate},estimated:true,virtualAdjustment:strength!==estimate.referenceStrength};
  }
  return { enabled: true, fNumber: 18 / (1 + 2 * strength / 100), apertureSource: 'visual-estimate', reference: null, estimated: true };
}

/** Shared preview/HQ contract. Never silently forces EXIF focal length
 * over a calibrated projection: mismatch remains explicit for the caller to fix
 * or identify as a virtual lens. Scene units include the calibrated bed metric.
 */
export function resolvePhotoLensDof({
  projectionMatrix, sourceUV = null, sourceSensorHeightMm = 24,
  worldToMm, focusDistanceWorld, focusSource = 'complete-model-bounds-estimate',
  imageHeightPx, dofEnabled = false, dofStrength = 35, photoIdentity = null,
} = {}) {
  finite(worldToMm, '场景单位到毫米', { positive: true });
  finite(focusDistanceWorld, '镜头焦点', { positive: true });
  finite(imageHeightPx, '画面像素高度', { positive: true });
  const sensor = photoLensSensorRegion({ projectionMatrix, sourceUV, sourceSensorHeightMm });
  const reference = photoLensDofReference(photoIdentity);
  const estimate = photoLensDofEstimate(photoIdentity);
  const aperture = photoLensAperture({ enabled: dofEnabled, strength: dofStrength, reference, estimate });
  const focusDistanceMm = focusDistanceWorld * worldToMm;
  if (aperture.enabled && focusDistanceMm <= sensor.physicalFocalLengthMm) throw new RangeError('估计焦点位于镜头焦距以内，不能使用真实薄透镜景深。');
  const focalReferenceMismatchRatio = reference ? Math.abs(sensor.physicalFocalLengthMm / reference.focalLengthMm - 1) : null;
  const coefficient = aperture.enabled ? sensor.physicalFocalLengthMm ** 2 /
    (aperture.fNumber * sensor.effectiveSensorHeightMm * (focusDistanceMm - sensor.physicalFocalLengthMm)) : 0;
  return {
    schemaVersion: 1, mode: 'thin-lens', ...sensor, ...aperture,
    photoIdentity: typeof photoIdentity === 'string' ? photoIdentity : null,
    sensorSource: reference?.sensorSource ?? 'full-frame-visual-estimate',
    focusDistanceWorld, focusDistanceMm, focusDistanceM: focusDistanceMm / 1000,
    focusSource, focusMeasured: false, worldToMm, imageHeightPx,
    referenceFocalLengthMm: reference?.focalLengthMm ?? null, focalReferenceMismatchRatio,
    focalMatchesReference: reference ? focalReferenceMismatchRatio <= .02 : null,
    cocDiameterUvCoefficient: coefficient, cocRadiusUvCoefficient: coefficient / 2,
    photoPixelsProtected: true,
    assumptions: ['thin-lens circular aperture', 'camera-axis depth', 'complete-model focus estimate', 'no repeated background blur'],
  };
}

/** Depth is in the same world units as the model/camera, not model-local mm. */
export function photoLensCoCAtDepth(contract, depthWorld) {
  if (depthWorld !== Infinity) finite(depthWorld, '镜头轴向深度', { positive: true });
  if (!contract.enabled) return { sensorDiameterMm: 0, diameterPixels: 0, radiusUvY: 0 };
  const sensorDiameterMm = thinLensCoCDiameterMm({ focalLengthMm: contract.physicalFocalLengthMm, fNumber: contract.fNumber,
    focusDistanceMm: contract.focusDistanceMm, depthMm: depthWorld === Infinity ? Infinity : depthWorld * contract.worldToMm });
  return { sensorDiameterMm, diameterPixels: sensorDiameterMm * contract.imageHeightPx / contract.effectiveSensorHeightMm,
    radiusUvY: sensorDiameterMm / contract.effectiveSensorHeightMm / 2 };
}
