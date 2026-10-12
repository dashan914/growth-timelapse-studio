import { execFile } from 'node:child_process';

const request = JSON.parse(process.argv[2]);
execFile(request.filename, request.args, { timeout: request.timeout, maxBuffer: request.maxBuffer, cwd: request.cwd,
  encoding: 'utf8', windowsHide: true, shell: false }, (error, stdout, stderr) => {
  process.stdout.write(JSON.stringify({ stdout, stderr, error: error ? {
    message: error.message, code: error.code, killed: error.killed, signal: error.signal,
  } : null }));
});
