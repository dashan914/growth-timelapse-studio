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
async function start(name) { segment = name; frame = 0; await fs.mkdir(path.join(output, name), { recursive: true }); }
async function click(selector) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.locator(selector).click();
}
async function slider(selector, proportion) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.click(box.x + 8 + (box.width - 16) * proportion, box.y + box.height / 2);
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
    '-loop', '0', path.join(root, 'docs', 'media', `${name}.gif`)], { maxBuffer: 1024 * 1024 });
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
  if (!only || only === 'current-workbench') {
  await start('current-workbench');
  await hold(1); await click('#restart-button'); await hold(5); await pauseAndFinish(); await hold(1);
  await page.screenshot({ path: path.join(output, 'current-workbench.png') });
  await encode(segment);
  }

  if (!only || only === 'current-backgrounds') {
  await start('current-backgrounds');
  for (const name of ['h2c', 'p1s', 'a1', 'blue-grey', 'pastel-rug', 'teal-room']) { await preset(name); await hold(1.25); }
  await page.screenshot({ path: path.join(output, 'current-backgrounds.png') });
  await encode(segment);
  }

  if (!only || only === 'current-transform') {
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

  if (!only || only === 'current-color-lens') {
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
  if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
  await fs.writeFile(path.join(output, 'capture.json'), JSON.stringify({ version: health.version, viewport: { width: 1440, height: 900 }, errors, date: new Date().toISOString() }, null, 2));
} finally { await browser.close(); }
