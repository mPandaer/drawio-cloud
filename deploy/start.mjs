import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/dist/apps/server/src/config.js';

const config = readConfig();
if (config.host !== '127.0.0.1' || config.port !== 3000) {
  throw new Error('容器内部 API 必须监听 127.0.0.1:3000；外部端口通过 Compose 配置。');
}
const template = await readFile(new URL('./nginx.conf.template', import.meta.url), 'utf8');
await writeFile('/tmp/drawio-nginx.conf', template.replace('__BODY_LIMIT__', String(config.bodyLimit)));

const api = spawn(process.execPath, ['/app/server/dist/apps/server/src/cli.js'], { stdio: 'inherit' });
const proxy = spawn('nginx', ['-c', '/tmp/drawio-nginx.conf', '-g', 'daemon off;'], { stdio: 'inherit' });
const children = [api, proxy];
let stopping = false;
let failed = false;
let exited = 0;
let timer;
function stop(failure) {
  failed ||= failure;
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  timer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10_000);
  timer.unref();
}
for (const child of children) {
  child.on('error', error => { console.error(error); stop(true); });
  child.on('close', (code, signal) => {
    stop(!stopping || (code !== 0 && signal !== 'SIGTERM'));
    if (++exited === children.length) {
      clearTimeout(timer);
      process.exitCode = failed ? 1 : 0;
    }
  });
}
process.once('SIGTERM', () => stop(false));
process.once('SIGINT', () => stop(false));
