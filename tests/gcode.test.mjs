import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGCode } from '../src/gcode.js';

const approximately = (actual, expected, tolerance = 1e-5) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} != ${expected[index]}`));
};

test('absolute axes and extrusion exclude travel, retract, and pure-E reprime', () => {
  const parsed = parseGCode(`G21
G90
M82
G0 X10 Y10 Z0.2
G1 X20 E1
G1 E0.5
G0 X30
G1 E1
G92 E0
G1 Y20 E0.3
G1 X40 E0.1
G1 Y30 E0.1`);
  assert.equal(parsed.segmentCount, 2);
  approximately([...parsed.positions], [10, 10, 0.2, 20, 10, 0.2, 30, 10, 0.2, 30, 20, 0.2]);
  assert.deepEqual([...parsed.layers], [0, 0]);
  assert.deepEqual(parsed.layerHeights, [0.2]);
  assert.deepEqual(parsed.bounds.min.slice(0, 2), [10, 10]);
  assert.deepEqual(parsed.bounds.max.slice(0, 2), [30, 20]);
});

test('relative axes and relative extrusion are independent modal states', () => {
  const parsed = parseGCode(`G90 G1 X10 Y10 Z.2
G91
M83
G1 X5 E.4
Y2 E.2
G90
G1 X30 E.3
M82
G92 E100
G1 Y20 E101`);
  assert.equal(parsed.segmentCount, 4);
  approximately([...parsed.positions], [10, 10, .2, 15, 10, .2, 15, 10, .2, 15, 12, .2, 15, 12, .2, 30, 12, .2, 30, 12, .2, 30, 20, .2]);
});

test('Z hops do not produce layers; only printed heights get sorted layer IDs', () => {
  const parsed = parseGCode(`M83
G0 Z.2
G1 X5 E1
G0 Z5
G0 X10
G0 Z.2
G1 X15 E1
G0 Z.4
G1 X20 E1
G0 Z.2
G1 X25 E1`);
  assert.deepEqual(parsed.layerHeights, [.2, .4]);
  assert.deepEqual([...parsed.layers], [0, 0, 1, 0]);
});

test('compact words, line numbers, comments, checksums, tools and inch conversion', () => {
  const parsed = parseGCode(`N1g20; inch mode
N2m83
N3g0x1y1z.01
t2
N4g1x2e.1*99
M104 T9 S210 ; heater selection must not switch tools
G1Y2E.1 (X999 E999)
G21
T0
G1X30E.2`);
  assert.equal(parsed.segmentCount, 3);
  assert.deepEqual([...parsed.tools], [2, 2, 0]);
  assert.equal(parsed.toolCount, 3);
  assert.deepEqual(parsed.layerHeights, [.254]);
  approximately([...parsed.positions], [25.4, 25.4, .254, 50.8, 25.4, .254, 50.8, 25.4, .254, 50.8, 50.8, .254, 50.8, 50.8, .254, 30, 50.8, .254]);
});

test('G92 axes reset working coordinates without teleporting geometry', () => {
  const parsed = parseGCode(`M83
G0X10Y10Z.2
G92X0Y0
G1X5E1
G91
G1Y5E1`);
  approximately([...parsed.positions], [10, 10, .2, 15, 10, .2, 15, 10, .2, 15, 15, .2]);
});

test('unsupported arcs are explicit and subsequent lines start at their endpoint', () => {
  const parsed = parseGCode(`M83
G0Z.2
G1X5E1
G2X10Y10I5J0E2
G3X20Y10I5J0E2
G1X25E1`);
  assert.equal(parsed.segmentCount, 2);
  approximately([...parsed.positions].slice(6), [20, 10, .2, 25, 10, .2]);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /G2\/G3.*结果不完整/);
  assert.throws(() => parseGCode('G2 X1 Y1 E1'), /圆弧尚不支持/);
});

test('segment limits return explicit incomplete warning and matching arrays', () => {
  const parsed = parseGCode('M83\nG1X1E1\nG1X2E1\nG1X3E1', { maxSegments: 2 });
  assert.equal(parsed.segmentCount, 2);
  assert.equal(parsed.positions.length, 12);
  assert.equal(parsed.layers.length, 2);
  assert.equal(parsed.tools.length, 2);
  assert.match(parsed.warnings[0], /超过 2 段限制/);
});

test('files without printed paths and invalid limits fail clearly', () => {
  assert.throws(() => parseGCode('G0X10Y10\nG1E1\nG1X20E-1'), /未找到可用的打印路径/);
  assert.throws(() => parseGCode(''), /未找到可用的打印路径/);
  assert.throws(() => parseGCode(null), TypeError);
  assert.throws(() => parseGCode('G1X1E1', { maxSegments: 0 }), RangeError);
  assert.throws(() => parseGCode('G1X1E1', { maxSegments: 2000001 }), RangeError);
});

test('typed storage grows beyond its initial allocation without losing paths', () => {
  const input = `M83\n${Array.from({ length: 9000 }, (_, i) => `G1X${i + 1}E.1`).join('\n')}`;
  const parsed = parseGCode(input);
  assert.equal(parsed.segmentCount, 9000);
  assert.equal(parsed.positions.at(-3), 9000);
  assert.deepEqual(parsed.layerHeights, [0]);
  assert.equal(parsed.layers.at(-1), 0);
});

test('slicer filament color headers preserve tool order and actual colors', () => {
  const parsed = parseGCode('; filament_colour = #FF0000;#00FF00;#0000FF\nM83\nT2\nG1X1E1\nT0\nG1X2E1');
  assert.deepEqual(parsed.toolColors, ['#ff0000', '#00ff00', '#0000ff']);
  assert.deepEqual(parsed.usedTools, [0, 2]);
  assert.deepEqual([...parsed.tools], [2, 0]);
});

test('JSON-style and trailing color configuration retains missing slots and filament precedence', () => {
  const parsed = parseGCode('M83\nT1\nG1X1E1\n; extruder_colour = #111111;#222222;#333333\n; filament_colors = ["#AaBbCcFF", "", "#Ff8000"]');
  assert.deepEqual(parsed.toolColors, ['#aabbcc', '#222222', '#ff8000']);
  assert.deepEqual(parsed.usedTools, [1]);
  const noFallback = parseGCode('; filament_colour = #112233;;#445566\nM83\nT2\nG1X1E1');
  assert.equal(noFallback.toolColors[1], undefined);
  assert.equal(noFallback.toolColors[2], '#445566');
});

test('TYPE and FEATURE annotations classify support and interface extrusion precisely', () => {
  const parsed = parseGCode('M83\n;TYPE:Support\nG1X1E1\n;TYPE:Support interface\nG1X2E1\n;TYPE:Outer wall\nG1X3E1\n; FEATURE: Support\nG1X4E1');
  assert.deepEqual([...parsed.support], [1, 1, 0, 1]);
  assert.equal(parsed.supportSegmentCount, 3);
});

test('support-only parsing advances body coordinates and extrusion without spending its segment limit', () => {
  const parsed = parseGCode('G90\nM82\n;FEATURE:Outer wall\nG1X1E1\nG1X2E2\nG1X3E3\n;FEATURE:Support\nG1X4E4\n;FEATURE:Outer wall\nG1X5E5\n;FEATURE:Support interface\nG1X6E6', { supportOnly: true, maxSegments: 2 });
  assert.equal(parsed.segmentCount, 2);
  assert.equal(parsed.supportSegmentCount, 2);
  assert.deepEqual([...parsed.positions], [3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0]);
  assert.equal(parsed.warnings.length, 0);
  assert.throws(() => parseGCode('M83\nG1X1E1', { supportOnly: true }), /没有标记为 Support/);
});

test('actual slicer extrusion width and layer height remain attached to each support segment', () => {
  const parsed = parseGCode('M83\n;TYPE:Support\n;WIDTH:0.5\n;HEIGHT:0.25\nG0Z.25\nG1X1E1\n;WIDTH:0.42\n;HEIGHT:0.12\nG0Z.37\nG1X2E1', { supportOnly: true });
  approximately([...parsed.widths], [0.5, 0.42]);
  approximately([...parsed.heights], [0.25, 0.12]);
});
