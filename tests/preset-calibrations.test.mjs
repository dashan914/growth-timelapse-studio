import test from 'node:test';
import assert from 'node:assert/strict';
import { presetDefinitions, getPresetCalibration } from '../src/preset-calibrations.js';
import { solvePlanarCamera, projectWorld } from '../src/calibration.js';

const printerKeys = ['h2c', 'p1s', 'a1'];
const tabletopKeys = ['pastel-rug', 'blue-grey', 'teal-room'];
const printers = printerKeys.map(key => [key, presetDefinitions[key]]);
const tabletops = tabletopKeys.map(key => [key, presetDefinitions[key]]);

const solve = preset => solvePlanarCamera({
  points: preset.points,
  widthPx: preset.imageSize.width, heightPx: preset.imageSize.height,
  bedWidth: preset.widthMm, bedDepth: preset.depthMm,
  allowOutside: preset.allowOutside,
  photoVerticalLines: preset.verticalLines,
  fov: preset.fov,
});

test('exact background presets recover above-bed cameras with modest observed edge residuals', () => {
  assert.deepEqual(Object.keys(presetDefinitions), [...printerKeys, ...tabletopKeys]);
  for (const [key, preset] of printers) {
    const camera = solve(preset);
    assert.ok(camera.position[1] > 100, `${key}: camera is above bed`);
    assert.ok(camera.fov > 45 && camera.fov < 65, `${key}: realistic wide-angle lens`);
    // The visible uprights are stronger orientation evidence than estimated
    // plate corners. Permit <1.2% of image width in the approximate perimeter.
    assert.ok(camera.reprojectionErrorPx < 45, `${key}: ${camera.reprojectionErrorPx}px`);
    for (const point of [[0, 0, 0], [0, 100, 0], [-50, 100, 50]]) {
      const projection = projectWorld(point, camera);
      assert.ok(projection.depth > 0, `${key}: model remains in front of the camera`);
      assert.ok(Number.isFinite(projection.x) && Number.isFinite(projection.y));
    }
    assert.ok(projectWorld([0, 100, 0], camera).y < projectWorld([0, 0, 0], camera).y, `${key}: the model grows upward in the photograph`);
  }
});

test('millimetre model coordinates share the nominal plate scale instead of fitting every model to the same size', () => {
  for (const [key, preset] of printers) {
    const camera = solve(preset);
    const widthFor = side => {
      const left = projectWorld([-side / 2, 0, 0], camera), right = projectWorld([side / 2, 0, 0], camera);
      return Math.hypot(right.x - left.x, right.y - left.y);
    };
    assert.ok(widthFor(100) > widthFor(50) * 1.95 && widthFor(100) < widthFor(50) * 2.1, `${key}: doubling actual model size doubles its visible footprint`);
    assert.ok(widthFor(100) > 300 && widthFor(100) < 1000, `${key}: plausible 100mm footprint on supplied photo`);
    const unitScale = solvePlanarCamera({
      points: preset.points,
      widthPx: preset.imageSize.width, heightPx: preset.imageSize.height,
      bedWidth: preset.widthMm / 100, bedDepth: preset.depthMm / 100, allowOutside: true,
      photoVerticalLines: preset.verticalLines,
    });
    const millimetres = projectWorld([35, 100, -20], camera);
    const equivalent = projectWorld([0.35, 1, -0.2], unitScale);
    assert.ok(Math.hypot(millimetres.x - equivalent.x, millimetres.y - equivalent.y) < 1e-5, `${key}: camera and model units agree`);
  }
});

test('cropped corners and reference scale are explicitly described as approximate', () => {
  assert.equal(presetDefinitions.h2c.widthMm, 330);
  assert.equal(presetDefinitions.h2c.depthMm, 320);
  for (const [, preset] of printers) {
    assert.equal(preset.approximate, true);
    assert.equal(preset.sizeBasis, 'reference-printable-area');
    assert.equal(preset.cropped, true);
    assert.equal(preset.allowOutside, true);
    assert.match(preset.warning, /估计.*微调/);
    assert.ok(preset.croppedCorners.every(i => preset.points[i].y > 1 || preset.points[i].x < 0 || preset.points[i].x > 1));
    assert.throws(() => solvePlanarCamera({ points: preset.points, widthPx: 3776, heightPx: 2832, bedWidth: preset.widthMm, bedDepth: preset.depthMm }), /画面内/);
  }
});

test('editable preset copies do not alter the reusable source definition', () => {
  const copy = getPresetCalibration('h2c');
  const originalX = presetDefinitions.h2c.points[0].x;
  copy.points[0].x = 0.99;
  copy.verticalLines[0].a.x = 0.99;
  copy.imageSize.width = 1;
  copy.croppedCorners.push(0);
  assert.equal(presetDefinitions.h2c.points[0].x, originalX);
  assert.notEqual(presetDefinitions.h2c.verticalLines[0].a.x, 0.99);
  assert.equal(presetDefinitions.h2c.imageSize.width, 3776);
  assert.deepEqual(presetDefinitions.h2c.croppedCorners, [3]);
  assert.equal(getPresetCalibration('unknown'), null);
});

test('preset camera revision includes independent, non-parallel real-printer upright observations', () => {
  for (const [, preset] of printers) {
    assert.equal(preset.calibrationRevision, 2);
    assert.equal(preset.verticalLines.length, 2);
    for (const { a, b, weight } of preset.verticalLines) {
      assert.equal(weight, 100);
      assert.ok([a.x, a.y, b.x, b.y].every(value => value >= 0 && value <= 1));
      assert.ok(Math.hypot((a.x - b.x) * 3776, (a.y - b.y) * 2832) > 600);
    }
    const [{ a: a0, b: b0 }, { a: a1, b: b1 }] = preset.verticalLines;
    assert.ok(Math.abs(a0.x - a1.x) > 0.3, 'the two physical uprights are widely separated');
    const slopes = [(b0.x - a0.x) / (b0.y - a0.y), (b1.x - a1.x) / (b1.y - a1.y)];
    assert.ok(Math.abs(slopes[0] - slopes[1]) > 0.1, 'photo convergence is retained instead of forcing vertical screen lines');
  }
});

test('joint photo fits follow real upright directions without forcing the camera roll to zero', () => {
  for (const [key, preset] of printers) {
    const camera = solve(preset);
    assert.ok(camera.verticalErrorDeg < 0.7, `${key}: ${camera.verticalErrorDeg}° upright error`);
    const planeOnly = solvePlanarCamera({ points: preset.points, widthPx: 3776, heightPx: 2832, bedWidth: preset.widthMm, bedDepth: preset.depthMm, allowOutside: true });
    const directionError = camera => {
      const r = camera.rotation, f = camera.focalLengthPx;
      const vanishing = [f * r[1] + 1888 * r[7], f * r[4] + 1416 * r[7], r[7]];
      return Math.sqrt(preset.verticalLines.reduce((sum, { a, b }) => {
        const dx = (b.x - a.x) * 3776, dy = (b.y - a.y) * 2832;
        const mx = (a.x + b.x) * 3776 / 2, my = (a.y + b.y) * 2832 / 2;
        const vx = vanishing[0] - mx * vanishing[2], vy = vanishing[1] - my * vanishing[2];
        const sine = Math.abs(dx * vy - dy * vx) / (Math.hypot(dx, dy) * Math.hypot(vx, vy));
        const angle = Math.asin(Math.min(1, sine)) * 180 / Math.PI;
        return sum + angle ** 2;
      }, 0) / preset.verticalLines.length);
    };
    assert.ok(directionError(camera) < directionError(planeOnly) * 0.6, `${key}: physical uprights improve substantially over plane-only fit`);
    assert.ok(Math.abs(camera.up[0]) > 0.015, `${key}: the real photograph's tilted screen axes remain present`);
    if (key === 'h2c') assert.ok(Math.abs(camera.fov - 53.13) < 3, 'H2C lens estimate agrees with the 24mm/full-height EXIF inference');
  }
});

test('generated tabletop presets use rigid product cameras and grow up from the usable surface', () => {
  for (const [key, preset] of tabletops) {
    const camera = solve(preset);
    assert.equal(camera.focalEstimated, false, `${key}: chosen lens is an estimate, not an inferred measurement`);
    assert.ok(camera.reprojectionErrorPx < 1e-6, `${key}: virtual rectangle fits one rigid camera`);
    assert.ok(camera.fov >= 24 && camera.fov <= 34, `${key}: modest product-photo field of view`);
    assert.ok(camera.position[1] > 0, `${key}: camera stays above the surface`);
    assert.ok(Math.abs(camera.rotation[1]) < 1e-8, `${key}: camera has no artificial screen roll`);
    const pitch = Math.asin(-camera.rotation[7]) * 180 / Math.PI;
    assert.ok(Math.abs(pitch - preset.visualCamera.pitchDeg) < 1e-6, `${key}: consistent downward optical pitch`);
    const growth = [0, 25, 50, 100].map(y => projectWorld([0, y, 0], camera));
    const foot = growth[0];
    assert.ok(Math.abs(foot.x / preset.imageSize.width - 0.5) < 1e-8, `${key}: origin is centered horizontally`);
    assert.ok(foot.y / preset.imageSize.height > 0.82 && foot.y / preset.imageSize.height < 0.86, `${key}: model foot is on the foreground surface`);
    growth.forEach((point, index) => {
      assert.ok(point.depth > 0 && point.y > 0 && point.y < preset.imageSize.height, `${key}: growth stays in front of the camera and in frame`);
      if (index) assert.ok(point.y < growth[index - 1].y, `${key}: positive height moves upward`);
    });
    assert.ok((foot.y - growth.at(-1).y) / preset.imageSize.height > 0.3, `${key}: 100 mm model occupies useful portrait height`);
  }
});

test('virtual tabletop scale remains metric and does not refit each model to the same footprint', () => {
  for (const [key, preset] of tabletops) {
    const camera = solve(preset);
    const widthFor = side => {
      const left = projectWorld([-side / 2, 0, 0], camera), right = projectWorld([side / 2, 0, 0], camera);
      return Math.hypot(right.x - left.x, right.y - left.y);
    };
    assert.ok(widthFor(100) > widthFor(50) * 1.95 && widthFor(100) < widthFor(50) * 2.1, `${key}: model dimensions retain their relative scale`);
    const smallerUnits = solvePlanarCamera({
      points: preset.points, widthPx: preset.imageSize.width, heightPx: preset.imageSize.height,
      bedWidth: preset.widthMm / 100, bedDepth: preset.depthMm / 100,
      fov: preset.fov, allowOutside: preset.allowOutside, photoVerticalLines: preset.verticalLines,
    });
    const millimetres = projectWorld([35, 100, -20], camera);
    const equivalent = projectWorld([0.35, 1, -0.2], smallerUnits);
    assert.ok(Math.hypot(millimetres.x - equivalent.x, millimetres.y - equivalent.y) < 1e-6, `${key}: camera and model can change units together`);
  }
});

test('100 mm tabletop models retain their feet and framing in source, 9:16 and 4:5 crops', () => {
  for (const [key, preset] of tabletops) {
    const source = solve(preset), sourceAspect = preset.imageSize.width / preset.imageSize.height;
    const model = [-50, 50].flatMap(x => [0, 100].flatMap(y => [-50, 50].map(z => [x, y, z])));
    for (const aspect of [sourceAspect, 9 / 16, 4 / 5]) {
      const width = Math.min(1, aspect / sourceAspect), height = Math.min(1, sourceAspect / aspect);
      const left = (1 - width) / 2, top = (1 - height) / 2;
      const targetHeight = 1000, targetWidth = targetHeight * aspect;
      const cropped = solvePlanarCamera({
        points: preset.points.map(point => ({ x: (point.x - left) / width, y: (point.y - top) / height })),
        widthPx: targetWidth, heightPx: targetHeight, bedWidth: preset.widthMm, bedDepth: preset.depthMm,
        fov: 2 * Math.atan(Math.tan(preset.fov * Math.PI / 360) * height) * 180 / Math.PI,
        allowOutside: true, photoVerticalLines: [],
      });
      for (const point of model) {
        const full = projectWorld(point, source), crop = projectWorld(point, cropped);
        const expected = { x: (full.x / preset.imageSize.width - left) / width, y: (full.y / preset.imageSize.height - top) / height };
        assert.ok(expected.x > 0.01 && expected.x < 0.99 && expected.y > 0.01 && expected.y < 0.99, `${key} ${aspect}: complete 100 mm model has a visible frame margin`);
        assert.ok(Math.hypot(crop.x / targetWidth - expected.x, crop.y / targetHeight - expected.y) < 1e-8, `${key} ${aspect}: model and photo share the crop transform`);
      }
    }
  }
});

test('generated tabletop definitions do not imply observed corners or physical table measurements', () => {
  for (const [key, preset] of tabletops) {
    assert.equal(preset.sizeBasis, 'virtual-scene-reference');
    assert.equal(preset.cameraBasis, 'estimated-product-photo');
    assert.equal(preset.approximate, true);
    assert.deepEqual(preset.verticalLines, [], `${key}: generated blur is not evidence for physical uprights`);
    assert.match(preset.warning, /没有可测量.*视觉估计.*虚拟摆放/);
    assert.equal(preset.sizeSource, undefined);
    const copy = getPresetCalibration(key), originalPitch = preset.visualCamera.pitchDeg;
    copy.points[0].x = 0;
    copy.visualCamera.pitchDeg = 90;
    copy.croppedCorners.push(0);
    assert.notEqual(copy.points[0].x, preset.points[0].x);
    assert.equal(preset.visualCamera.pitchDeg, originalPitch);
    assert.notEqual(copy.croppedCorners.length, preset.croppedCorners.length);
  }
});
