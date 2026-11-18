/** Run Next.js and the persistent WebSocket relay as one local process group. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const children = [
  spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), mode], { cwd: root, env: process.env, stdio: 'inherit' }),
  spawn(process.execPath, [resolve(root, 'server/index.mjs')], { cwd: root, env: process.env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error); stop(1); });
  child.on('exit', (code, signal) => { if (!stopping) { console.error(`RetroDeck process exited (${code ?? signal}).`); stop(code || 1); } });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
