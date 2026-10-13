import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePrintLayerGCode } from '../src/print-layer.js';
import { indexSliceGCode } from '../slice-jobs.mjs';

const directory = path.resolve(process.argv[2]);
const results = JSON.parse(await readFile(path.join(directory, 'slicing-results.json'), 'utf8'));
for (const result of results) {
  if (result.status !== 'sliced') continue;
  try {
    const text = await readFile(result.gcode, 'utf8');
    const parsed = parsePrintLayerGCode(text, { includeSupport: true });
    const index = await indexSliceGCode(result.gcode);
    if (!parsed.segmentCount || !parsed.layerHeights.length || !parsed.exactLinearPaths
        || Math.abs(parsed.layerHeights.at(-1) - 5) > 0.2) {
      throw new Error('Incomplete model paths or unexpected final model height');
    }
    result.status = 'passed';
    result.segments = parsed.segmentCount;
    result.layers = parsed.layerHeights.length;
    result.finalHeightMm = parsed.layerHeights.at(-1);
    result.indexedLayers = index.layerCount;
    result.g130 = /^\s*G130\s/m.test(text);
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  }
}
await writeFile(path.join(directory, 'results.json'), JSON.stringify(results, null, 2) + '\n');
for (const result of results) console.log(JSON.stringify(result));
const failed = results.filter(result => result.status !== 'passed');
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }));
process.exitCode = failed.length ? 1 : 0;
