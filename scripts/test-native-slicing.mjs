import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test', '--test-concurrency=1',
  'tests/slice-backend.test.mjs', 'tests/slice-source-worker.test.mjs',
  'tests/slice-loader-assembly.test.mjs', 'tests/slice-vertex-colors.test.mjs',
  'tests/windows-runtime.test.mjs'], {
  env: { ...process.env, GROWTH_NATIVE_SLICER_TESTS: '1' }, stdio: 'inherit', shell: false, windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
