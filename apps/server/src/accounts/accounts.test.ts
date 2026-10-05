import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import * as argon2 from 'argon2';
import { createApplication } from '../app.js';
import { readConfig } from '../config.js';
import { createAccountsModule } from './index.js';

const origin = 'http://localhost:8080';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(publicOrigin = origin, authorityProbe = false, env: NodeJS.ProcessEnv = {}, argon?: { hash: typeof argon2.hash; verify: typeof argon2.verify }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-accounts-'));
  const clock = { value: 1_800_000_000_000, now() { return this.value; } };
  const config = readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: publicOrigin, ...env });
  let signalPrepared!: () => void; let releasePreparation!: () => void;
  const prepared = new Promise<void>(resolve => { signalPrepared = resolve; });
  const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
  const open = () => createApplication({ config, clock, compose(context) {
    const accounts = createAccountsModule(context, { argon2: argon });
    return [accounts.module, ...(authorityProbe ? [{ register(app: Awaited<ReturnType<typeof createApplication>>) {
      app.post<{ Body: { ownerId: string; delay?: boolean } }>('/api/account-authority-probe', async request => {
        const actor = accounts.resolveIdentity(request);
        accounts.identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        if (request.body.delay) { signalPrepared(); await preparation; }
        return context.transactions.write(tx => { accounts.identity.authorizeFile(tx, actor, request.body.ownerId); return { authorized: true }; });
      });
    } }] : [])];
  } });
  const app = await open();
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, clock, open, prepared, releasePreparation };
}
const admin = { username: ' 管理员 ', password: 'admin-password-123' };

test('明确的多入口白名单允许登录与修改，仍拒绝未知来源及错误CSRF', async () => {
  const alternatives = ['http://server.local.com:6768', 'http://100.109.38.54:6768'];
  const { app } = await setup(origin, false, { ALLOWED_ORIGINS: alternatives.join(',') });
  await bootstrap(app);
  for (const entry of [origin, ...alternatives]) {
    const session = await login(app, admin, entry);
    expect(session.response.statusCode).toBe(200);
    const headers = { cookie: session.cookie, origin: entry, 'x-csrf-token': 'wrong' };
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).json().error.code).toBe('INVALID_CSRF');
    headers['x-csrf-token'] = session.auth.csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, origin: 'http://evil.example' } })).json().error.code).toBe('INVALID_ORIGIN');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).statusCode).toBe(204);
  }
  expect((await login(app, admin, 'http://evil.example')).response.statusCode).toBe(403);
});

test.each(['*', 'http://good.example,', 'https://good.example', 'http://good.example/path', 'http://user:pass@good.example'])('非法入口白名单 %s 拒绝配置', value => {
  expect(() => readConfig({ DATA_DIR: '/tmp/test', PUBLIC_ORIGIN: origin, ALLOWED_ORIGINS: value })).toThrow('ALLOWED_ORIGINS');
});

test('可信代理后的客户端独立限速，未受信任来源不能用XFF绕过', async () => {
  const { app } = await setup(origin, false, { TRUSTED_PROXIES: '127.0.0.1/32' });
  const attempt = (remoteAddress: string, forwarded: string) => app.inject({ method: 'POST', url: '/api/bootstrap', remoteAddress,
    headers: { origin, 'x-forwarded-for': forwarded }, payload: { ...admin, password: '' } });
  for (let i = 0; i < 5; i++) expect((await attempt('127.0.0.1', '192.0.2.1')).statusCode).toBe(400);
  expect((await attempt('127.0.0.1', '192.0.2.1')).statusCode).toBe(429);
  expect((await attempt('127.0.0.1', '192.0.2.2')).statusCode).toBe(400);
  for (let i = 0; i < 5; i++) expect((await attempt('198.51.100.1', `192.0.2.${i + 10}`)).statusCode).toBe(400);
  expect((await attempt('198.51.100.1', '192.0.2.99')).statusCode).toBe(429);
});

test('登录账号规范化限速跨IP生效，同一地址的其他账号仍能尝试且轮换账号受IP上界限制', async () => {
  const { app } = await setup();
  const attempt = (username: string, remoteAddress = '192.0.2.1') => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress,
    headers: { origin }, payload: { username, password: 'incorrect-password' } });
  for (let i = 0; i < 5; i++) expect((await attempt(i % 2 ? ' ALICE ' : 'alice', `192.0.2.${i + 1}`)).statusCode).toBe(401);
  expect((await attempt('Alice', '192.0.2.9')).statusCode).toBe(429);
  expect((await attempt('bob')).statusCode).toBe(401);
  for (let i = 0; i < 23; i++) expect((await attempt(`other-${i}`)).statusCode).toBe(401);
  expect((await attempt('last-other')).statusCode).toBe(429);
});

test('轮换IP及用户名仍受全局限速上界约束，到期释放预算', async () => {
  const { app, clock } = await setup();
  const attempt = (i: number) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `198.51.${Math.floor(i / 250)}.${i % 250 + 1}`,
    headers: { origin }, payload: { username: `unknown-${i}`, password: '' } });
  for (let i = 0; i < 250; i++) expect((await attempt(i)).statusCode).toBe(400);
  expect((await attempt(250)).statusCode).toBe(429);
  clock.value += 60_000;
  expect((await attempt(251)).statusCode).toBe(400);
});

test('单IP大量被拒登录不消耗全局预算阻断其他来源', async () => {
  const { app } = await setup();
  for (let i = 0; i < 300; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.1',
      headers: { origin }, payload: { username: `blocked-${i}`, password: '' } });
    expect(response.statusCode).toBe(i < 25 ? 400 : 429);
  }
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.2',
    headers: { origin }, payload: { username: 'another-user', password: '' } })).statusCode).toBe(400);
});

test('跨IP的账号桶拒绝不消耗其他账号的全局预算', async () => {
  const { app } = await setup();
  for (let i = 0; i < 270; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `198.51.${Math.floor(i / 250)}.${i % 250 + 1}`,
      headers: { origin }, payload: { username: 'blocked-account', password: 'incorrect-password' } });
    expect(response.statusCode).toBe(i < 5 ? 401 : 429);
  }
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.2',
    headers: { origin }, payload: { username: 'other-account', password: 'incorrect-password' } })).statusCode).toBe(401);
});

test('不存在账号也经过真实Argon2验证且返回相同凭据错误', async () => {
  const verified: string[] = [];
  const { app } = await setup(origin, false, {}, { hash: argon2.hash, async verify(encoded, password, options) {
    verified.push(encoded);
    return argon2.verify(encoded, password, options);
  } });
  await bootstrap(app);
  const missing = await login(app, { username: 'missing', password: 'wrong-password' });
  const existing = await login(app, { ...admin, password: 'wrong-password' });
  expect(missing.response.json()).toEqual(existing.response.json());
  expect(verified).toHaveLength(2);
  for (const encoded of verified) {
    expect(encoded).toMatch(/^\$argon2id\$v=19\$/);
    expect(encoded.split('$')[3]?.split(',').sort()).toEqual(['m=65536', 'p=1', 't=3']);
  }
});

async function bootstrap(app: Awaited<ReturnType<typeof createApplication>>, publicOrigin = origin) {
  await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin: publicOrigin }, payload: admin });
}
async function login(app: Awaited<ReturnType<typeof createApplication>>, payload = admin, publicOrigin = origin) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: publicOrigin }, payload });
  return { response, cookie: String(response.headers['set-cookie']).split(';')[0]!, auth: response.json() };
}

test('登录规范化用户名并返回固定七天身份及HTTP安全Cookie，过期不续期', async () => {
  const { app, clock } = await setup();
  await bootstrap(app);
  const { response, cookie, auth } = await login(app);
  expect(response.statusCode).toBe(200);
  expect(auth.user).toMatchObject({ username: '管理员', role: 'admin', disabled: false });
  expect(auth.expiresAt).toBe(1_800_604_800_000);
  expect(response.headers['set-cookie']).toContain('HttpOnly');
  expect(response.headers['set-cookie']).toContain('SameSite=Lax');
  expect(response.headers['set-cookie']).not.toContain('Secure');
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toEqual(auth);
  clock.value += 604_799_999;
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json().expiresAt).toBe(auth.expiresAt);
  clock.value++;
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
});

test('登录验证来源和密码、限制尝试频率，HTTPS Cookie设置Secure且伪造令牌被拒绝', async () => {
  const secureOrigin = 'https://draw.example';
  const { app, clock } = await setup(secureOrigin);
  await bootstrap(app, secureOrigin);
  expect((await login(app)).response.statusCode).toBe(403);
  for (let i = 0; i < 5; i++) expect((await login(app, { ...admin, password: 'incorrect-password' }, secureOrigin)).response.statusCode).toBe(401);
  expect((await login(app, admin, secureOrigin)).response.statusCode).toBe(429);
  clock.value += 60_000;
  const session = await login(app, admin, secureOrigin);
  expect(session.response.headers['set-cookie']).toContain('Secure');
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: 'drawio_session=forged' } })).statusCode).toBe(401);
});

test('退出必须同源且CSRF绑定当前会话，退出仅撤销当前会话', async () => {
  const { app } = await setup();
  await bootstrap(app);
  const first = await login(app); const second = await login(app);
  for (const [headers, code] of [
    [{ cookie: first.cookie, 'x-csrf-token': first.auth.csrfToken }, 'INVALID_ORIGIN'],
    [{ cookie: first.cookie, origin, 'x-csrf-token': second.auth.csrfToken }, 'INVALID_CSRF'],
    [{ cookie: first.cookie, origin }, 'INVALID_CSRF'],
  ] as const) expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers })).json().error.code).toBe(code);
  const result = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: first.cookie, origin, 'x-csrf-token': first.auth.csrfToken } });
  expect(result.statusCode).toBe(204);
  expect(result.headers['set-cookie']).toContain('Max-Age=0');
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: second.cookie } })).statusCode).toBe(200);
});

test('修改密码核验旧密码并撤销所有旧会话，新密码可以登录', async () => {
  const { app, clock } = await setup(); await bootstrap(app);
  const first = await login(app); const second = await login(app);
  const headers = { cookie: first.cookie, origin, 'x-csrf-token': first.auth.csrfToken };
  expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: 'wrong-password', newPassword: 'new-password-123' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: admin.password, newPassword: 'new-password-123' } })).statusCode).toBe(204);
  for (const cookie of [first.cookie, second.cookie]) expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  expect((await login(app)).response.statusCode).toBe(401);
  clock.value += 60_000;
  expect((await login(app, { ...admin, password: 'new-password-123' })).response.statusCode).toBe(200);
});

test('管理员创建普通账号，名称规范化唯一且普通用户不能管理账号', async () => {
  const { app } = await setup(); await bootstrap(app); const manager = await login(app);
  const headers = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const created = await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: ' Alice ', password: 'alice-password-123', role: 'admin' } });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({ username: 'Alice', role: 'user', disabled: false });
  expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'ALICE', password: 'other-password' } })).json().error.code).toBe('USERNAME_EXISTS');
  const ordinary = await login(app, { username: 'alice', password: 'alice-password-123' });
  expect(ordinary.response.statusCode).toBe(200);
  expect((await app.inject({ url: '/api/admin/users', headers: { cookie: manager.cookie } })).json().users).toHaveLength(2);
  expect((await app.inject({ url: '/api/admin/users', headers: { cookie: ordinary.cookie } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: ordinary.cookie, origin, 'x-csrf-token': ordinary.auth.csrfToken }, payload: { username: 'Bob', password: 'bob-password' } })).statusCode).toBe(403);
});

test('管理员重置密码撤销目标全部会话，普通用户不能重置他人密码', async () => {
  const { app } = await setup(); await bootstrap(app); const manager = await login(app);
  const headers = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'Alice', password: 'alice-password' } })).json();
  const first = await login(app, { username: 'alice', password: 'alice-password' });
  const second = await login(app, { username: 'alice', password: 'alice-password' });
  expect((await app.inject({ method: 'POST', url: `/api/admin/users/${manager.auth.user.id}/password`, headers: { cookie: first.cookie, origin, 'x-csrf-token': first.auth.csrfToken }, payload: { newPassword: 'reset-password' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: `/api/admin/users/${user.id}/password`, headers, payload: { newPassword: 'reset-password' } })).statusCode).toBe(204);
  for (const cookie of [first.cookie, second.cookie]) expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  expect((await login(app, { username: 'alice', password: 'reset-password' })).response.statusCode).toBe(200);
});

test('停用即时撤销会话且禁止登录，恢复需重新登录，最后管理员受保护', async () => {
  const { app, clock } = await setup(); await bootstrap(app); const manager = await login(app);
  const headers = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'Alice', password: 'alice-password' } })).json();
  const ordinary = await login(app, { username: 'alice', password: 'alice-password' });
  expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: { cookie: ordinary.cookie, origin, 'x-csrf-token': ordinary.auth.csrfToken }, payload: { disabled: true } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers, payload: { disabled: true } })).json()).toMatchObject({ disabled: true });
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: ordinary.cookie } })).statusCode).toBe(401);
  expect((await login(app, { username: 'alice', password: 'alice-password' })).response.json().error.code).toBe('ACCOUNT_DISABLED');
  expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers, payload: { disabled: false } })).json()).toMatchObject({ disabled: false });
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: ordinary.cookie } })).statusCode).toBe(401);
  clock.value += 60_000;
  expect((await login(app, { username: 'alice', password: 'alice-password' })).response.statusCode).toBe(200);
  expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${manager.auth.user.id}`, headers, payload: { disabled: true } })).json().error.code).toBe('LAST_ADMIN');
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: manager.cookie } })).statusCode).toBe(200);
});

test('登录密码校验期间停用账号不能签发可用会话，恢复后旧登录不得复活', async () => {
  let entered!: () => void; let resume!: () => void; let hold = false;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const { app, clock } = await setup(origin, false, {}, { hash: argon2.hash, async verify(encoded, password, options) {
    const valid = await argon2.verify(encoded, password, options);
    if (hold) { entered(); await gate; }
    return valid;
  } }); await bootstrap(app); const manager = await login(app);
  const headers = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'Alice', password: 'alice-password' } })).json();
  hold = true;
  const pending = login(app, { username: 'alice', password: 'alice-password' });
  await verifying;
  try {
    expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers, payload: { disabled: true } })).statusCode).toBe(200);
  } finally { hold = false; resume(); }
  const late = await pending;
  expect(late.response.json().error.code).toBe('ACCOUNT_DISABLED');
  await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers, payload: { disabled: false } });
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: late.cookie } })).statusCode).toBe(401);
  clock.value += 60_000;
  expect((await login(app, { username: 'alice', password: 'alice-password' })).response.statusCode).toBe(200);
});

test('登录校验期间重置密码后旧凭据不能签发会话', async () => {
  let entered!: () => void; let resume!: () => void; let hold = false;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const { app } = await setup(origin, false, {}, { hash: argon2.hash, async verify(encoded, password, options) {
    const valid = await argon2.verify(encoded, password, options);
    if (hold) { entered(); await gate; }
    return valid;
  } });
  await bootstrap(app); const manager = await login(app);
  const headers = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { username: 'Alice', password: 'alice-password' } })).json();
  hold = true;
  const pending = login(app, { username: 'alice', password: 'alice-password' });
  await verifying;
  try {
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${user.id}/password`, headers, payload: { newPassword: 'replacement-password' } })).statusCode).toBe(204);
  } finally { hold = false; resume(); }
  const late = await pending;
  expect(late.response.json().error.code).toBe('INVALID_CREDENTIALS');
  expect((await app.inject({ url: '/api/auth/me', headers: { cookie: late.cookie } })).statusCode).toBe(401);
  expect((await login(app, { username: 'alice', password: 'replacement-password' })).response.statusCode).toBe(200);
});

test('事务授权允许本人及管理员，拒绝他人及请求准备期间被停用的身份', async () => {
  const { app, prepared, releasePreparation } = await setup(origin, true); await bootstrap(app); const manager = await login(app);
  const managerHeaders = { cookie: manager.cookie, origin, 'x-csrf-token': manager.auth.csrfToken };
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: managerHeaders, payload: { username: 'Alice', password: 'alice-password' } })).json();
  const ordinary = await login(app, { username: 'alice', password: 'alice-password' });
  const headers = { cookie: ordinary.cookie, origin, 'x-csrf-token': ordinary.auth.csrfToken };
  expect((await app.inject({ method: 'POST', url: '/api/account-authority-probe', headers, payload: { ownerId: user.id } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/account-authority-probe', headers, payload: { ownerId: manager.auth.user.id } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/account-authority-probe', headers: managerHeaders, payload: { ownerId: user.id } })).statusCode).toBe(200);
  const pending = app.inject({ method: 'POST', url: '/api/account-authority-probe', headers, payload: { ownerId: user.id, delay: true } }).then(r => r);
  await prepared;
  await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: managerHeaders, payload: { disabled: true } });
  releasePreparation();
  expect((await pending).statusCode).toBe(401);
});

test('初始化拒绝异源、缺失来源、空用户名和无效密码且没有默认账号', async () => {
  const { app } = await setup();
  for (const headers of [{}, { origin: 'http://evil.example' }]) {
    expect((await app.inject({ method: 'POST', url: '/api/bootstrap', headers, payload: admin })).json().error.code).toBe('INVALID_ORIGIN');
  }
  for (const payload of [{ ...admin, username: ' ' }, { ...admin, password: '' }, { username: 'x' }]) {
    expect((await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload })).statusCode).toBe(400);
  }
  expect((await app.inject('/api/bootstrap')).json()).toEqual({ initialized: false });
});

test('初始化按来源地址限速，窗口到期可以重试', async () => {
  const { app, clock } = await setup();
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload: { ...admin, password: '' } });
  expect((await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload: admin })).statusCode).toBe(429);
  clock.value += 60_000;
  expect((await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload: admin })).statusCode).toBe(201);
});

test('并发初始化仅一个管理员成功，重启后入口永久关闭', async () => {
  const { app, open } = await setup();
  expect((await app.inject('/api/bootstrap')).json()).toEqual({ initialized: false });
  const responses = await Promise.all([admin, { ...admin, username: '第二管理员' }].map(payload => app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload })));
  expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
  expect((await app.inject('/api/bootstrap')).json()).toEqual({ initialized: true });
  await app.close();
  const reopened = await open();
  cleanups.push(() => reopened.close());
  expect((await reopened.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload: admin })).json().error.code).toBe('ALREADY_INITIALIZED');
});
