// Printer calibration is tied to these exact photographs, not to every photo of
// the same printer. Points follow physical rear-left, rear-right, front-right,
// front-left and are normalized against the complete 3776 × 2832 source image.
// The rounded plate corners, front tabs and hidden/cropped corners mean these
// are approximate initial camera fits. No point is clamped into the picture:
// doing so would change the perspective and the displayed size of the model.
const points = corners => corners.map(([x, y]) => ({ x: x / 800, y: y / 600 }));
// Long, visible metal guides are more reliable orientation references than
// guessed corners outside the photograph. Generic manual fits use the solver's
// conservative default; these inspected templates give uprights more weight.
const verticalLines = lines => lines.map(([ax, ay, bx, by]) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, weight: 100 }));
const imageSize = { width: 3776, height: 2832 };
const sizeWarning = '模型按毫米和预设打印区域比例显示；底板外缘及裁切角点为估计，可在透视网格中微调。';
const visualScaleWarning = '背景没有可测量的真实平台；长宽、镜头和角点均为视觉估计，表示虚拟摆放区域，可在透视网格中微调。';

/**
 * Generated tabletop plates contain no measured calibration rectangle. Project
 * a virtual rectangle through an ordinary, upright product-photo camera, so
 * the four editable points describe a rigid camera rather than an arbitrary
 * screen trapezoid. The target height is chosen to put the origin at footY;
 * pitch/yaw/FOV/distance are visual choices, not recovered EXIF or measurements.
 * Millimetres remain consistent with imported models, while the apparent scale
 * can be adjusted by editing this virtual area or moving/scaling the model.
 */
function visualTabletop({ label, fileName, imageSize, fov, pitchDeg, yawDeg = 0, distanceMm, footY = 0.83 }) {
  const widthMm = 180, depthMm = 140;
  const pitch = pitchDeg * Math.PI / 180, yaw = yawDeg * Math.PI / 180;
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  const q = (footY - 0.5) * 2 * Math.tan(fov * Math.PI / 360);
  const targetHeight = q * distanceMm / (cp - q * sp);
  const focal = imageSize.height / (2 * Math.tan(fov * Math.PI / 360));
  const corners = [[-widthMm / 2, -depthMm / 2], [widthMm / 2, -depthMm / 2], [widthMm / 2, depthMm / 2], [-widthMm / 2, depthMm / 2]];
  const projected = corners.map(([x, z]) => {
    const depth = distanceMm + targetHeight * sp - cp * sy * x - cp * cy * z;
    return {
      x: 0.5 + focal * (cy * x - sy * z) / depth / imageSize.width,
      y: 0.5 + focal * (sp * sy * x + sp * cy * z + targetHeight * cp) / depth / imageSize.height,
    };
  });
  const croppedCorners = projected.flatMap((point, index) => point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 ? [index] : []);
  return {
    label, fileName, calibrationRevision: 1, points: projected, verticalLines: [],
    widthMm, depthMm, imageSize: { ...imageSize }, fov, allowOutside: true,
    approximate: true, cropped: croppedCorners.length > 0, croppedCorners,
    warning: visualScaleWarning, sizeBasis: 'virtual-scene-reference',
    cameraBasis: 'estimated-product-photo',
    visualCamera: { pitchDeg, yawDeg, distanceMm, footY },
  };
}

/**
 * Reviewed initial fits for the user's supplied backgrounds. Printer entries
 * use the manufacturer's nominal printable area as a scale reference, not a
 * measured steel-sheet perimeter. Generated tabletop entries instead describe
 * a virtual placement area and estimated product-photo optics. Exact physical
 * matching requires a measured rectangle or a finished-model reference photo.
 */
export const presetDefinitions = {
  h2c: {
    label: 'H2C', fileName: 'DSC04419.jpg',
    calibrationRevision: 2,
    points: points([[154, 305], [486, 276], [762, 465], [148, 625]]),
    // Rear guide and front-right rod: physical Z-uprights, not a roll-zero
    // assumption. Their directions constrain world Y independently of the
    // rounded/cropped plate perimeter. All endpoints use the full photograph.
    verticalLines: verticalLines([
      [0.4383355513, 0.1777777778, 0.4370986761, 0.4666666667],
      [0.9602915301, 0.2611111111, 0.8894711473, 0.65],
    ]),
    widthMm: 330, depthMm: 320,
    imageSize: { ...imageSize }, allowOutside: true,
    approximate: true, cropped: true, croppedCorners: [3],
    warning: sizeWarning,
    sizeBasis: 'reference-printable-area',
    sizeSource: 'https://store.bblcdn.com/s7/default/d741f5a073c94245885065ff89a0b2da/H2C_Spec.pdf',
  },
  p1s: {
    label: 'P1S', fileName: 'DSC04422.jpg',
    calibrationRevision: 2,
    points: points([[380, 318], [705, 385], [564, 727], [124, 469]]),
    // Front-left guide and the rear guide screw are well separated in image.
    verticalLines: verticalLines([
      [0.1432831641, 0.3711111111, 0.1863016029, 0.6888888889],
      [0.6976780669, 0.3011111111, 0.6859585608, 0.5577777778],
    ]),
    widthMm: 256, depthMm: 256,
    imageSize: { ...imageSize }, allowOutside: true,
    approximate: true, cropped: true, croppedCorners: [2],
    warning: sizeWarning,
    sizeBasis: 'reference-printable-area',
    sizeSource: 'https://us.store.bambulab.com/products/bambu-textured-pei-plate',
  },
  a1: {
    label: 'A1', fileName: 'DSC04420.jpg',
    calibrationRevision: 2,
    points: points([[172, 326], [456, 281], [724, 429], [313, 602]]),
    // Inner edges of the two gantry pillars. The shallow convergence remains
    // present; setting the screen tilt to zero would not match the photograph.
    verticalLines: verticalLines([
      [0.1736578525, 0.2077777778, 0.1983237357, 0.6233333333],
      [0.6225537932, 0.0966666667, 0.5928937275, 0.4733333333],
    ]),
    widthMm: 256, depthMm: 256,
    imageSize: { ...imageSize }, allowOutside: true,
    approximate: true, cropped: true, croppedCorners: [3],
    warning: sizeWarning,
    sizeBasis: 'reference-printable-area',
    sizeSource: 'https://us.store.bambulab.com/products/bambu-textured-pei-plate',
  },
  'pastel-rug': visualTabletop({
    label: '彩绒台面', fileName: 'pastel-rug.png',
    imageSize: { width: 1087, height: 1447 },
    fov: 30, pitchDeg: 21, distanceMm: 430,
  }),
  'blue-grey': visualTabletop({
    label: '蓝灰摄影棚', fileName: 'blue-grey.png',
    imageSize: { width: 1086, height: 1448 },
    fov: 28, pitchDeg: 18, distanceMm: 460,
  }),
  'teal-room': visualTabletop({
    label: '青绿室内', fileName: 'teal-room.png',
    imageSize: { width: 1086, height: 1448 },
    // A mild side view follows the desk's visible rear corner without treating
    // the generated, blurred edge as an accurately measured rectangular table.
    fov: 30, pitchDeg: 18, yawDeg: 22, distanceMm: 490,
  }),
};

/** Return editable copies, so dragging a corner cannot modify the preset. */
export function getPresetCalibration(key) {
  if(!Object.hasOwn(presetDefinitions,key))return null;
  const definition = presetDefinitions[key];
  if (!definition) return null;
  return {
    ...definition,
    points: definition.points.map(point => ({ ...point })),
    verticalLines: definition.verticalLines.map(line => ({ ...line, a: { ...line.a }, b: { ...line.b } })),
    imageSize: { ...definition.imageSize },
    croppedCorners: [...definition.croppedCorners],
    ...(definition.visualCamera && { visualCamera: { ...definition.visualCamera } }),
  };
}
