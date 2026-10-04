import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApplication } from '../../server/src/app.js';
import { readConfig } from '../../server/src/config.js';
import { createApiClient } from './api.js';
import { composeBackend } from '../../server/src/compose.js';

test('浏览器账号客户端读取初始化状态并保留身份失效错误码', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), compose: composeBackend });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const client = createApiClient(address);
    expect(await client.bootstrap()).toEqual({ initialized: false });
    await expect(client.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP200错误健康响应形状不能被当成服务正常', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.get('/invalid/api/health', async () => ({ status: 'broken' })); },
  }] });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(createApiClient(`${address}/invalid`).health()).rejects.toThrow('服务暂时出现错误，请稍后重试。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP200非JSON响应仍返回中文失败提示', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.get('/html/api/health', async (_request, reply) => reply.type('text/html').send('<h1>Proxy page</h1>')); },
  }] });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(createApiClient(`${address}/html`).health()).rejects.toThrow('服务暂时出现错误，请稍后重试。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('真实HTTP连接断开时前端返回中文提示', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.get('/disconnect/api/health', async (_request, reply) => { reply.hijack(); reply.raw.destroy(); }); },
  }] });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(createApiClient(`${address}/disconnect`).health()).rejects.toThrow('服务暂时出现错误，请稍后重试。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('代理返回非JSON错误时前端显示通用中文提示', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.get('/proxy/api/health', async (_request, reply) => reply.code(502).type('text/html').send('<h1>Bad Gateway</h1>')); },
  }] });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(createApiClient(`${address}/proxy`).health()).rejects.toThrow('服务暂时出现错误，请稍后重试。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('旧前端收到未知错误码时保留服务器提示', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.get('/future/api/health', async (_request, reply) => reply.code(409).send({ error: { code: 'NEW_ERROR', message: '服务正在维护，请稍后重试。' } })); },
  }] });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(createApiClient(`${address}/future`).health()).rejects.toThrow('服务正在维护，请稍后重试。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('前端健康客户端通过真实HTTP读取状态并把错误映射为中文', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-client-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }) });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    expect(await createApiClient(address).health()).toEqual({ status: 'ok' });
    await expect(createApiClient(`${address}/missing`).health()).rejects.toThrow('请求的资源不存在。');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
