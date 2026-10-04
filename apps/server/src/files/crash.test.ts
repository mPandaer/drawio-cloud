import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { createApplication } from '../app.js';
import { readConfig } from '../config.js';
import { composeBackend } from '../compose.js';

for (const stage of ['before', 'after']) test(`真实HTTP保存SQLite提交${stage === 'before' ? '前' : '后'}SIGKILL重启正文版本一致`, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-crash-'));
  const origin = 'http://localhost:8080';
  const child = fork(new URL('./crash-worker.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], env: { ...process.env, DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, CRASH_STAGE: stage }, silent: true });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr?.on('data', data => { stderr += String(data); });
  const message = () => Promise.race([once(child, 'message').then(([value]) => value), exited.then(() => { throw new Error(`worker exited: ${stderr}`); })]);
  try {
    const { port } = await message() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const request = (path: string, method = 'GET', payload?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { origin, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    expect((await request('/api/bootstrap', 'POST', { username: 'admin', password: 'admin-password' })).status).toBe(201);
    const login = await request('/api/auth/login', 'POST', { username: 'admin', password: 'admin-password' });
    const auth = await login.json() as { csrfToken: string };
    const headers = { origin, cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': auth.csrfToken };
    const file = await (await request('/api/files', 'POST', { name: 'Crash.drawio' }, headers)).json() as { id: string };
    const original = await (await request(`/api/files/${file.id}/content`, 'GET', undefined, headers)).json() as { content: string };
    const lease = await (await request(`/api/files/${file.id}/edit-session`, 'POST', { windowId: 'crash-window' }, headers)).json() as object;
    const armed = message(); child.send('arm'); expect(await armed).toBe('armed');
    const content = '<mxGraphModel><root><mxCell id="0" value="committed"/></root></mxGraphModel>';
    const interrupted = message();
    const pending = request(`/api/files/${file.id}/content`, 'PUT', { ...lease, expectedRevision: 1, content }, headers).catch(() => undefined);
    expect(await interrupted).toBe(stage);
    child.kill('SIGKILL'); await exited; await pending;
    const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: origin }), compose: composeBackend });
    try {
      const read = await app.inject({ url: `/api/files/${file.id}/content`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json().content).toBe(stage === 'before' ? original.content : content);
      expect(read.json().file.revision).toBe(stage === 'before' ? 1 : 2);
      expect((await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'other' } })).json().error.code).toBe('FILE_OCCUPIED');
      expect(await readdir(join(dataDir, 'blobs'))).toHaveLength(1);
    } finally { await app.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(dataDir, { recursive: true, force: true });
  }
}, 15_000);
