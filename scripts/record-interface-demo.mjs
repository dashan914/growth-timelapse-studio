// Maintainer-only capture: operate the actual local UI, then encode screenshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findFFmpegPath } from '../runtime-paths.mjs';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(process.env.CAPTURE_NODE_MODULES + '/package.json');
const { chromium } = require('playwright');
const output = process.env.CAPTURE_OUTPUT || '/private/tmp/growth-beta5-interface-capture';
const url = process.env.CAPTURE_URL || 'http://127.0.0.1:44430/';
const executable = process.env.CAPTURE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const only = process.env.CAPTURE_ONLY || '';
const selections = new Set(only.split(','));
const featureGuides = new Set(['current-supports', 'current-bed-calibration', 'current-model-colors']);
const selected = name => !only || selections.has(name) || (selections.has('feature-guides') && featureGuides.has(name));
const browser = await chromium.launch({ headless: true, executablePath: executable });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let segment, frame = 0;
await fs.mkdir(output, { recursive: true });

async function screenshot() {
  await page.screenshot({ path: path.join(output, segment, `frame-${String(frame++).padStart(4, '0')}.png`) });
}
async function hold(seconds = 1) {
  for (let i = 0; i < Math.ceil(seconds * 4); i++) { await screenshot(); await page.waitForTimeout(250); }
}
async function start(name) {
  segment = name; frame = 0;
  await fs.rm(path.join(output, name), { recursive: true, force: true });
  await fs.mkdir(path.join(output, name), { recursive: true });
}
async function click(selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.locator(selector).click();
}
async function slider(selector, proportion) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + 8 + (box.width - 16) * proportion, box.y + box.height / 2);
}
async function chooseColor(selector, color) {
  await page.locator(selector).fill(color.toLowerCase());
  if (await page.locator(selector).inputValue() !== color.toLowerCase()) throw new Error('Color input did not update');
}
async function dragHandle(selector, dx, dy) {
  const box = await page.locator(selector).locator('circle').first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x + dx * i / 8, y + dy * i / 8);
    await screenshot();
  }
  await page.mouse.up();
}
async function pauseAndFinish() {
  if (await page.locator('#play-button').getAttribute('aria-label') === '暂停动画') await click('#play-button');
  await page.locator('#timeline').focus(); await page.keyboard.press('End');
}
async function preset(name) {
  await click(`[data-preset="${name}"]`);
  await page.waitForTimeout(600);
}
async function encode(name) {
  await run(findFFmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', '4', '-i',
    path.join(output, name, 'frame-%04d.png'), '-filter_complex',
    '[0:v]scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-frames:v', String(frame), '-loop', '0', path.join(root, 'docs', 'media', `${name}.gif`)], { maxBuffer: 1024 * 1024 });
  console.log(JSON.stringify({ name, frames: frame, seconds: frame / 4, width: 1280, height: 800 }));
}

try {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('#model-input').setInputFiles(path.join(root, 'examples', '测试2.3mf'));
  await page.locator('#import-phase').filter({ hasText: '导入完成' }).waitFor({ timeout: 180000 });
  await pauseAndFinish();
  const health = await (await page.request.get(url + 'api/health')).json();
  console.log(JSON.stringify({ version: health.version, imported: await page.locator('#model-type').textContent() }));
  for (const label of ['阴影调节', '色彩匹配', '镜头设置']) {
    if (!(await page.getByRole('button', { name: label, exact: true }).isVisible())) throw new Error('Missing current tool ' + label);
  }
  if (await page.locator('#canvas-perspective').count()) throw new Error('Old toolbar perspective still present');

  await preset('blue-grey');
  await page.locator('#growth-duration').fill('4'); await page.locator('#growth-duration').press('Tab');
  if (selected('current-workbench')) {
  await start('current-workbench');
  await hold(1); await click('#restart-button'); await hold(5); await pauseAndFinish(); await hold(1);
  await page.screenshot({ path: path.join(output, 'current-workbench.png') });
  await encode(segment);
  }

  if (selected('current-backgrounds')) {
  await start('current-backgrounds');
  for (const name of ['h2c', 'p1s', 'a1', 'blue-grey', 'pastel-rug', 'teal-room']) { await preset(name); await hold(1.25); }
  await page.screenshot({ path: path.join(output, 'current-backgrounds.png') });
  await encode(segment);
  }

  if (selected('current-transform')) {
  await preset('blue-grey'); await pauseAndFinish();
  await start('current-transform');
  await click('#canvas-move'); await hold(1.5);
  await page.screenshot({ path: path.join(output, 'move-handles.png') });
  // Coordinates come from the actual 1440x900 move-handles screenshot.
  await page.mouse.move(820, 622);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(820 + i * 4, 622); await screenshot(); }
  await page.mouse.up(); await hold(.75);
  await page.screenshot({ path: path.join(output, 'after-move.png') });
  await click('#canvas-rotate'); await hold(1.25);
  await preset('blue-grey'); await pauseAndFinish();
  await click('#canvas-scale'); await hold(1.25);
  await page.screenshot({ path: path.join(output, 'scale-handles.png') });
  await page.mouse.move(810, 605); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(810 + i * 2, 605 - i * 1.5); await screenshot(); }
  await page.mouse.up(); await hold(.75);
  await page.screenshot({ path: path.join(output, 'after-scale.png') });
  await click('#canvas-lock'); await hold(1);
  await encode(segment);
  }

  if (selected('current-color-lens')) {
  await start('current-color-lens');
  await click('#canvas-shadow'); await hold(1.25); await slider('#canvas-shadow-opacity', .65); await hold(.75); await click('#close-shadow');
  await click('#canvas-color'); await hold(1.25); await slider('#lighting-exposure', .68); await hold(.75); await slider('#lighting-temperature', .34); await hold(.75);
  await page.screenshot({ path: path.join(output, 'current-color.png') });
  await click('#close-color'); await click('#canvas-dof'); await hold(1.25);
  await page.locator('#camera-focal-length-number').fill('35'); await page.locator('#camera-focal-length-number').press('Tab');
  await page.locator('#dof-enabled').check(); await slider('#dof-strength', .45); await hold(1.25);
  await page.screenshot({ path: path.join(output, 'current-lens.png') });
  await click('#close-dof'); await hold(.75); await encode(segment);
  }

  if (selected('current-supports')) {
  await preset('blue-grey'); await pauseAndFinish();
  if (await page.locator('#show-supports').isDisabled()) throw new Error('The imported project has no actual supports to demonstrate');
  await page.locator('#show-supports').check();
  await start('current-supports');
  await hold(1.5);
  await page.screenshot({ path: path.join(output, 'supports-on.png') });
  await click('#show-supports'); await hold(2);
  await page.screenshot({ path: path.join(output, 'supports-off.png') });
  await click('#show-supports'); await hold(1.5);
  await slider('#timeline', .55); await hold(1.5);
  await page.screenshot({ path: path.join(output, 'supports-growing.png') });
  await pauseAndFinish(); await hold(1);
  await encode(segment);
  }

  if (selected('current-bed-calibration')) {
  await page.locator('#show-supports').uncheck();
  await preset('h2c'); await pauseAndFinish();
  await start('current-bed-calibration');
  await hold(1); await click('#calibrate-button'); await hold(1.5);
  await click('#bed-size-preset-trigger'); await hold(.75);
  await click('#bed-size-preset-listbox-0'); await hold(1);
  await page.screenshot({ path: path.join(output, 'bed-four-corners.png') });
  await dragHandle('#calibration-points [data-point="1"]', -6, 3); await hold(.75);
  await click('#calibration-handle-select-trigger'); await hold(.5);
  await click('#calibration-handle-select-listbox-1');
  await click('[data-calibration-nudge][data-dx="1"]'); await hold(.5);
  await page.screenshot({ path: path.join(output, 'bed-corner-adjusted.png') });
  await click('[data-calibration-step="1"]'); await hold(1.5);
  await page.locator('#use-upright-guides').uncheck();
  await dragHandle('#calibration-uprights [data-upright="0"][data-endpoint="b"]', -2, 3); await hold(.75);
  await page.locator('#use-upright-guides').check(); await hold(1.25);
  await page.screenshot({ path: path.join(output, 'bed-vertical-guides.png') });
  const calibration = {
    width: await page.locator('#bed-width').inputValue(),
    depth: await page.locator('#bed-depth').inputValue(),
    confirmed: await page.locator('#use-upright-guides').isChecked(),
    fit: await page.locator('#calibration-status').textContent(),
    vertical: await page.locator('#upright-guide-status').textContent(),
  };
  if (await page.locator('#apply-calibration').isDisabled()) throw new Error('Calibration is not valid');
  await click('#apply-calibration'); await hold(1.5);
  await page.locator('#calibration-panel').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(output, 'bed-calibration-complete.png') });
  await fs.writeFile(path.join(output, 'calibration.json'), JSON.stringify(calibration, null, 2));
  await encode(segment);
  }

  if (selected('current-model-colors')) {
  await preset('blue-grey'); await pauseAndFinish();
  await page.locator('#show-supports').uncheck();
  await page.locator('#preserve-materials').check();
  const originalColors = await page.locator('#material-color-list input').evaluateAll(inputs => inputs.map(input => input.value));
  if (originalColors.length < 2) throw new Error('A multicolor project is required');
  await start('current-model-colors');
  await hold(1.5);
  await chooseColor('#material-color-list input >> nth=0', '#64bde8'); await hold(1.5);
  await chooseColor('#material-color-list input >> nth=1', '#f1b146'); await hold(1.5);
  await page.screenshot({ path: path.join(output, 'model-part-colors.png') });
  if (!(await page.locator('#preserve-materials').isChecked())) throw new Error('Partition colors were not preserved');
  await chooseColor('#model-color', '#c5b6eb'); await hold(2);
  if (await page.locator('#preserve-materials').isChecked()) throw new Error('Uniform color did not replace partition colors');
  await page.screenshot({ path: path.join(output, 'model-uniform-color.png') });
  await click('#preserve-materials'); await hold(1.5);
  await chooseColor('#material-color-list input >> nth=0', originalColors[0]);
  await chooseColor('#material-color-list input >> nth=1', originalColors[1]); await hold(1.5);
  await page.screenshot({ path: path.join(output, 'model-original-colors.png') });
  await fs.writeFile(path.join(output, 'colors.json'), JSON.stringify({ originalColors, partitionColors: ['#64bde8', '#f1b146'], uniformColor: '#c5b6eb' }, null, 2));
  await encode(segment);
  }
  if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
  await fs.writeFile(path.join(output, 'capture.json'), JSON.stringify({ version: health.version, viewport: { width: 1440, height: 900 }, errors, date: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
