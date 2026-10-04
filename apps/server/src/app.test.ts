import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApplication } from './app.js';
import { readConfig } from './config.js';
import { ApiError } from './errors.js';
import type { IdentityAuthority, IdentityResolver } from './module-contracts.js';

test('真实 HTTP 响应仅限制同源嵌入而不限制外部素材来源', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-csp-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }) });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/health`);
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('组合根注入模块依赖后通过HTTP提供服务', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-composition-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), clock: { now: () => 12345 },
    compose(context) {
      const resolveIdentity: IdentityResolver = () => ({ user: { id: 'u1', username: '测试', role: 'user', disabled: false }, sessionId: 's1', csrfToken: 'csrf1', expiresAt: 99999 });
      const identity: IdentityAuthority = {
        requireMutation(identity, credentials) {
          if (credentials.origin !== context.config.publicOrigin || credentials.csrfToken !== identity.csrfToken) throw new ApiError('INVALID_CSRF');
        },
        revalidate(_tx, identity) { return identity; },
        authorizeFile() {},
      };
      return [{ register(app) { app.post('/api/composed', async (request) => {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string | undefined });
        return { time: context.clock.now(), userId: actor.user.id };
      }); } }];
    },
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/composed', headers: { origin: 'http://localhost:8080', 'x-csrf-token': 'csrf1' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ time: 12345, userId: 'u1' });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('通用HTTP正文超限不声称绘图文档已被校验', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-request-'));
  const config = readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' });
  const app = await createApplication({ config: { ...config, bodyLimit: 16 }, modules: [{
    register(app) { app.post('/api/echo', async (request) => request.body); },
  }] });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/echo', payload: { value: '01234567890123456789' } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: { code: 'REQUEST_TOO_LARGE', message: '请求内容超过大小限制，请减少请求内容。' } });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('不支持的客户端媒体类型保持415并返回中文请求错误', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-request-'));
  const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
    register(app) { app.post('/api/echo', async (request) => request.body); },
  }] });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/xml' }, payload: '<xml />' });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '请求内容类型不受支持，请使用 JSON。' } });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('装配模块抛出领域错误时 HTTP 使用统一映射', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-foundation-'));
  try {
    const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }), modules: [{
      register(app) { app.get('/api/test-failure', async () => { throw new ApiError('LEASE_LOST'); }); },
    }] });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/test-failure' });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: { code: 'LEASE_LOST', message: '编辑锁已失效，保存已暂停，请下载当前内容。' } });
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('未知 HTTP 资源返回共享中文错误而非框架文本', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-foundation-'));
  try {
    const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }) });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/missing' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: '请求的资源不存在。' } });
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('空数据目录启动后通过 HTTP 提供健康状态', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-foundation-'));
  try {
    const app = await createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }) });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
