import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const probes = new Map();

export function movAlphaEncoderArguments() {
  return ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16', '-f', 'mov'];
}

// An installed FFmpeg may omit this encoder or its alpha pixel format.
// Probe the executable itself before reserving an export or rendering frames.
export function probeMovAlphaEncoder(executable) {
  const previous = probes.get(executable);
  if (previous && Date.now() - previous.createdAt < 30_000) return previous.promise;
  const promise = execFileAsync(executable, ['-hide_banner', '-h', 'encoder=prores_ks'], { timeout: 5000, maxBuffer: 128 * 1024 })
    .then(({ stdout, stderr }) => {
      const help = `${stdout}\n${stderr}`;
      return { available: /^Encoder prores_ks\b/m.test(help) && /Supported pixel formats:[^\n]*\byuva444p10le\b/.test(help) && /-alpha_bits\b/.test(help) && /\b4444\b/.test(help) };
    }, () => ({ available: false }));
  probes.set(executable, { promise, createdAt: Date.now() });
  return promise;
}
