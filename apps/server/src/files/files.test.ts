import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createApplication } from '../app.js';
import { readConfig } from '../config.js';
import { createAccountsModule } from '../accounts/index.js';
import { createStorageModule } from './storage/index.js';
import { createFilesModule } from './index.js';
import { createEditingModule } from '../editing/index.js';
import { systemStorageIO } from './storage/io.js';
import type { StorageIO } from '../module-contracts.js';
import { deflateRawSync } from 'node:zlib';

const origin = 'http://localhost:8080';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { io?: StorageIO; maxBytes?: number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-files-'));
  const clock = { value: 1_800_000_000_000, now() { return this.value; } };
  const config = readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: origin, ...(options.maxBytes ? { MAX_DOCUMENT_BYTES: String(options.maxBytes) } : {}) });
  const open = () => createApplication({ config, clock, compose(context) {
    const accounts = createAccountsModule(context);
    const storage = createStorageModule(context, { io: options.io });
    const editing = createEditingModule(context, accounts);
    const files = createFilesModule(context, { ...accounts, ...storage, ...editing });
    return [accounts.module, editing.module, files.module];
  } });
  const app = await open();
  cleanups.push(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin }, payload: { username: 'admin', password: 'admin-password' } });
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password: 'admin-password' } });
  const auth = response.json();
  const headers = { origin, cookie: String(response.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.csrfToken as string };
  return { app, open, headers, auth, clock, dataDir };
}

test('并发租约申请只有一个窗口获得60秒有效凭据且管理员不能抢占', async () => {
  const { app, headers } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Lease.drawio' } })).json();
  const responses = await Promise.all(['window-a', 'window-b'].map(windowId => app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId } })));
  expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
  const lease = responses.find(response => response.statusCode === 201)!.json();
  expect(lease).toMatchObject({ expiresAt: 1_800_000_060_000 });
  expect(lease.leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('FILE_OCCUPIED');
});

test('每10秒续租延长60秒，凭据绑定窗口，释放后其他窗口立即取得新锁', async () => {
  const { app, headers, clock } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Renew.drawio' } })).json();
  const url = `/api/files/${file.id}/edit-session`;
  const lease = (await app.inject({ method: 'POST', url, headers, payload: { windowId: 'window-a' } })).json();
  clock.value += 10_000;
  expect((await app.inject({ method: 'PATCH', url, headers, payload: { ...lease, windowId: 'window-b' } })).json().error.code).toBe('LEASE_LOST');
  const renewed = await app.inject({ method: 'PATCH', url, headers, payload: lease });
  expect(renewed.statusCode).toBe(200);
  expect(renewed.json()).toEqual({ ...lease, expiresAt: 1_800_000_070_000 });
  expect((await app.inject({ method: 'DELETE', url, headers, payload: lease })).statusCode).toBe(204);
  const next = await app.inject({ method: 'POST', url, headers, payload: { windowId: 'window-b' } });
  expect(next.statusCode).toBe(201);
  expect(next.json().leaseToken).not.toBe(lease.leaseToken);
});

test('租约重启保留，另一个登录会话不能借用token，到期旧token不能复活或释放新锁', async () => {
  const { app, open, headers, clock } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Restart.drawio' } })).json();
  const url = `/api/files/${file.id}/edit-session`;
  const lease = (await app.inject({ method: 'POST', url, headers, payload: { windowId: 'window-a' } })).json();
  await app.close();
  const reopened = await open(); cleanups.push(() => reopened.close());
  expect((await reopened.inject({ method: 'POST', url, headers, payload: { windowId: 'window-b' } })).json().error.code).toBe('FILE_OCCUPIED');
  const login = await reopened.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'admin', password: 'admin-password' } });
  const other = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
  expect((await reopened.inject({ method: 'PATCH', url, headers: other, payload: lease })).json().error.code).toBe('LEASE_LOST');
  clock.value += 60_000;
  expect((await reopened.inject({ method: 'PATCH', url, headers, payload: lease })).json().error.code).toBe('LEASE_LOST');
  const next = await reopened.inject({ method: 'POST', url, headers: other, payload: { windowId: 'window-b' } });
  expect(next.statusCode).toBe(201);
  expect((await reopened.inject({ method: 'DELETE', url, headers, payload: lease })).json().error.code).toBe('LEASE_LOST');
  expect((await reopened.inject({ method: 'PATCH', url, headers: other, payload: next.json() })).statusCode).toBe(200);
  expect((await reopened.inject({ url: `/api/files/${file.id}/content`, headers })).json().file.revision).toBe(1);
});

test('列表搜索大小写包含匹配，重命名不改变正文和归属，用户范围名称唯一', async () => {
  const { app, headers, auth } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Architecture.drawio' } })).json();
  expect((await app.inject({ url: '/api/files?search=CHITECT', headers })).json()).toEqual({ files: [file] });
  const renamed = await app.inject({ method: 'PATCH', url: `/api/files/${file.id}`, headers, payload: { name: ' Renamed.drawio ' } });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json()).toMatchObject({ name: 'Renamed.drawio', ownerId: auth.user.id, revision: 1 });
  expect((await app.inject({ url: '/api/files?search=architecture', headers })).json()).toEqual({ files: [] });
  expect((await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'RENAMED.drawio' } })).json().error.code).toBe('NAME_EXISTS');
  for (const name of ['', ' ', 'x/y', 'x\\y']) expect((await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name } })).json().error.code).toBe('INVALID_NAME');
  const another = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Other.drawio' } })).json();
  expect((await app.inject({ method: 'PATCH', url: `/api/files/${another.id}`, headers, payload: { name: 'renamed.drawio' } })).json().error.code).toBe('NAME_EXISTS');
  expect((await app.inject({ url: `/api/files/${file.id}/content`, headers })).json().file).toEqual(renamed.json());
});

test('有效租约并发保存仅一次提交，旧版本和跨窗口token不改变完整正文', async () => {
  const { app, headers } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Save.drawio' } })).json();
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'window-a' } })).json();
  const content = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="完整中文" parent="1"/></root></mxGraphModel>';
  const url = `/api/files/${file.id}/content`;
  const payload = { ...lease, expectedRevision: 1, content };
  const responses = await Promise.all([app.inject({ method: 'PUT', url, headers, payload }), app.inject({ method: 'PUT', url, headers, payload })]);
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
  expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('REVISION_CONFLICT');
  expect(responses.find(response => response.statusCode === 200)!.json()).toMatchObject({ revision: 2, size: 133 });
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...payload, expectedRevision: 2, windowId: 'window-b' } })).json().error.code).toBe('LEASE_LOST');
  const read = (await app.inject({ url, headers })).json();
  expect(read.content).toBe(content);
  expect(read.file.revision).toBe(2);
});

test.each(['LEASE_LOST', 'REVISION_CONFLICT'] as const)('保存被%s拒绝后立即清理准备的blob且成功正文仍可读取', async (code) => {
  const { app, headers, dataDir } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'CleanupSave.drawio' } })).json();
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'cleanup' } })).json();
  const url = `/api/files/${file.id}/content`;
  const content = '<mxGraphModel><root><mxCell id="0" value="committed"/></root></mxGraphModel>';
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...lease, expectedRevision: 1, content } })).statusCode).toBe(200);
  const blobs = await readdir(join(dataDir, 'blobs'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await app.inject({ method: 'PUT', url, headers, payload: {
      ...lease, expectedRevision: code === 'REVISION_CONFLICT' ? 1 : 2,
      leaseToken: code === 'LEASE_LOST' ? 'forged' : lease.leaseToken,
      content: `<mxGraphModel><root><mxCell id="0" value="rejected-${attempt}"/></root></mxGraphModel>`,
    } });
    expect(response.json().error.code).toBe(code);
    expect(await readdir(join(dataDir, 'blobs'))).toEqual(blobs);
  }
  expect((await app.inject({ url, headers })).json()).toMatchObject({ content, file: { revision: 2 } });
});

test('保存和导入统一按实际UTF8限制，JSON编码开销可通过且超限保留旧版本', async () => {
  const { app, headers } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Limit.drawio' } })).json();
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'window-a' } })).json();
  const url = `/api/files/${file.id}/content`;
  const content = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>${' '.repeat(20 * 1024 * 1024)}`;
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...lease, expectedRevision: 1, content } })).json().error.code).toBe('DOCUMENT_TOO_LARGE');
  expect((await app.inject({ url, headers })).json().file.revision).toBe(1);
});

test('导入未压缩多页原文并原生下载，拒绝非法扩展名XML和XXE', async () => {
  const { app, headers } = await setup();
  const content = '<mxfile><diagram name="一"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram><diagram name="二"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="data:image/png;base64,aGVsbG8=" parent="1"/></root></mxGraphModel></diagram></mxfile>';
  const imported = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Multi.drawio', content } });
  expect(imported.statusCode).toBe(201);
  const file = imported.json();
  const download = await app.inject({ url: `/api/files/${file.id}/download`, headers });
  expect(download.statusCode).toBe(200);
  expect(download.body).toBe(content);
  expect(download.headers['content-disposition']).toContain('attachment;');
  expect((await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'MULTI.drawio', content } })).json().error.code).toBe('NAME_EXISTS');
  for (const [name, xml] of [['bad.xml', content], ['bad.drawio', '<mxfile>'], ['bad.drawio', '<foo/>'], ['bad.drawio', '<!DOCTYPE mxfile [<!ENTITY x SYSTEM "file:///etc/passwd">]><mxfile>&x;</mxfile>']]) {
    expect((await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name, content: xml } })).json().error.code).toBe('INVALID_DOCUMENT');
  }
});

test('同名导入反复失败后立即清理准备的blob且成功导入仍可下载', async () => {
  const { app, headers, dataDir } = await setup();
  const content = '<mxGraphModel><root><mxCell id="0" value="imported"/></root></mxGraphModel>';
  const imported = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'CleanupImport.drawio', content } });
  expect(imported.statusCode).toBe(201);
  const blobs = await readdir(join(dataDir, 'blobs'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const rejected = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: {
      name: 'CLEANUPIMPORT.drawio', content: `<mxGraphModel><root><mxCell id="0" value="rejected-${attempt}"/></root></mxGraphModel>`,
    } });
    expect(rejected.json().error.code).toBe('NAME_EXISTS');
    expect(await readdir(join(dataDir, 'blobs'))).toEqual(blobs);
  }
  expect((await app.inject({ url: `/api/files/${imported.json().id}/download`, headers })).body).toBe(content);
});

test('永久删除必须确认且有效锁任何角色不能删除，释放后删除不可见且不能再申请锁', async () => {
  const { app, headers } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Delete.drawio' } })).json();
  const url = `/api/files/${file.id}`;
  expect((await app.inject({ method: 'DELETE', url, headers, payload: { confirmed: false } })).json().error.code).toBe('INVALID_REQUEST');
  const lease = (await app.inject({ method: 'POST', url: `${url}/edit-session`, headers, payload: { windowId: 'window-a' } })).json();
  expect((await app.inject({ method: 'DELETE', url, headers, payload: { confirmed: true } })).json().error.code).toBe('FILE_OCCUPIED');
  await app.inject({ method: 'DELETE', url: `${url}/edit-session`, headers, payload: lease });
  const responses = await Promise.all([
    app.inject({ method: 'DELETE', url, headers, payload: { confirmed: true } }),
    app.inject({ method: 'POST', url: `${url}/edit-session`, headers, payload: { windowId: 'window-b' } }),
  ]);
  if (responses[0]!.statusCode === 204) expect(responses[1]!.json().error.code).toBe('NOT_FOUND');
  else {
    expect(responses[0]!.json().error.code).toBe('FILE_OCCUPIED');
    await app.inject({ method: 'DELETE', url: `${url}/edit-session`, headers, payload: responses[1]!.json() });
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { confirmed: true } })).statusCode).toBe(204);
  }
  expect((await app.inject({ url: `${url}/content`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `${url}/download`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: '/api/files', headers })).json()).toEqual({ files: [] });
});

test('两普通用户全端点隔离，管理员跨用户操作保持owner和owner范围名称', async () => {
  const { app, headers: manager } = await setup();
  const userHeaders = async (username: string) => {
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: manager, payload: { username, password: 'user-password' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username, password: 'user-password' } });
    return { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
  };
  const alice = await userHeaders('alice'); const bob = await userHeaders('bob');
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers: alice, payload: { name: 'Same.drawio' } })).json();
  const bobFile = (await app.inject({ method: 'POST', url: '/api/files', headers: bob, payload: { name: 'Same.drawio' } })).json();
  expect(bobFile.ownerId).not.toBe(file.ownerId);
  const content = (await app.inject({ url: `/api/files/${file.id}/content`, headers: alice })).json().content;
  expect((await app.inject({ url: '/api/files?search=SAME', headers: bob })).json().files).toEqual([bobFile]);
  expect((await app.inject({ url: '/api/files?search=SAME', headers: manager })).json().files).toHaveLength(2);
  for (const [method, suffix, payload] of [
    ['GET', '/content', undefined], ['GET', '/download', undefined], ['PATCH', '', { name: 'stolen.drawio' }],
    ['DELETE', '', { confirmed: true }], ['POST', '/edit-session', { windowId: 'bob-window' }],
    ['PUT', '/content', { content, expectedRevision: 1, leaseToken: 'forged', windowId: 'bob-window' }],
  ] as const) expect((await app.inject({ method, url: `/api/files/${file.id}${suffix}`, headers: bob, payload })).statusCode).toBe(403);
  for (const url of ['/api/files', '/api/files/import']) expect((await app.inject({ method: 'POST', url, payload: { name: 'Anonymous.drawio', content } })).statusCode).toBe(401);
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers: manager, payload: { windowId: 'manager' } })).json();
  expect((await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: manager, payload: { confirmed: true } })).json().error.code).toBe('FILE_OCCUPIED');
  expect((await app.inject({ method: 'PUT', url: `/api/files/${file.id}/content`, headers: manager, payload: { ...lease, content, expectedRevision: 1 } })).statusCode).toBe(200);
  const renamed = await app.inject({ method: 'PATCH', url: `/api/files/${file.id}`, headers: manager, payload: { name: 'AdminEdited.drawio' } });
  expect(renamed.json()).toMatchObject({ ownerId: file.ownerId, ownerUsername: 'alice', name: 'AdminEdited.drawio', revision: 2 });
  await app.inject({ method: 'DELETE', url: `/api/files/${file.id}/edit-session`, headers: manager, payload: lease });
  expect((await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers: manager, payload: { confirmed: true } })).statusCode).toBe(204);
});

test('停用密码重置修改与退出级联撤销真实文件租约，原文件仍保留', async () => {
  const { app, headers: manager } = await setup();
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: manager, payload: { username: 'alice', password: 'user-password' } })).json();
  let password = 'user-password';
  for (const action of ['disable', 'reset', 'password', 'logout']) {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password } });
    const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
    const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: `${action}.drawio` } })).json();
    const url = `/api/files/${file.id}/edit-session`;
    const lease = (await app.inject({ method: 'POST', url, headers, payload: { windowId: 'alice' } })).json();
    if (action === 'disable') {
      await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: manager, payload: { disabled: true } });
      await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: manager, payload: { disabled: false } });
    } else if (action === 'reset') {
      password = 'reset-password';
      await app.inject({ method: 'POST', url: `/api/admin/users/${user.id}/password`, headers: manager, payload: { newPassword: password } });
    } else if (action === 'password') {
      await app.inject({ method: 'POST', url: '/api/auth/password', headers, payload: { currentPassword: password, newPassword: 'changed-password' } });
      password = 'changed-password';
    } else await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect((await app.inject({ method: 'PATCH', url, headers, payload: lease })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: manager, payload: { windowId: 'manager' } })).statusCode).toBe(201);
    expect((await app.inject({ url: `/api/files/${file.id}/content`, headers: manager })).json().file.ownerId).toBe(user.id);
  }
});

test('真实系统IO写入失败与准备期间停用都不提交正文，重启清理孤立blob且并发读取一致', async () => {
  let mode = 'normal'; let entered!: () => void; let resume!: () => void;
  const prepared = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const io: StorageIO = { ...systemStorageIO, async writeAndSync(path, content) {
    if (mode === 'fail') throw new Error('disk failure');
    await systemStorageIO.writeAndSync(path, content);
    if (mode === 'hold') { entered(); await gate; }
  } };
  const { app, open, headers: manager, dataDir } = await setup({ io });
  const user = (await app.inject({ method: 'POST', url: '/api/admin/users', headers: manager, payload: { username: 'alice', password: 'user-password' } })).json();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { username: 'alice', password: 'user-password' } });
  const headers = { origin, cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken };
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Fault.drawio' } })).json();
  const url = `/api/files/${file.id}/content`;
  const original = (await app.inject({ url, headers })).json();
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'alice' } })).json();
  const payload = { ...lease, expectedRevision: 1, content: '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>' };
  mode = 'fail';
  expect((await app.inject({ method: 'PUT', url, headers, payload })).json().error.code).toBe('STORAGE_FAILURE');
  expect((await app.inject({ url, headers })).json()).toEqual(original);
  mode = 'hold';
  const pending = app.inject({ method: 'PUT', url, headers, payload }).then(response => response);
  await prepared;
  const reading = app.inject({ url, headers: manager }).then(response => response);
  await app.inject({ method: 'PATCH', url: `/api/admin/users/${user.id}`, headers: manager, payload: { disabled: true } });
  mode = 'normal'; resume();
  expect((await pending).statusCode).toBe(401);
  expect((await reading).json()).toEqual(original);
  expect(await readdir(join(dataDir, 'blobs'))).toHaveLength(1);
  await app.close();
  const reopened = await open(); cleanups.push(() => reopened.close());
  expect((await reopened.inject({ url, headers: manager })).json()).toEqual(original);
  expect(await readdir(join(dataDir, 'blobs'))).toHaveLength(1);
});

test('删除提交后清理失败不恢复可见，重启清理且missing正文拒启动', async () => {
  let fail = false;
  const io: StorageIO = { ...systemStorageIO, async remove(path) { if (fail) throw new Error('cleanup failed'); await systemStorageIO.remove(path); } };
  const { app, open, headers, dataDir } = await setup({ io });
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Cleanup.drawio' } })).json();
  fail = true;
  expect((await app.inject({ method: 'DELETE', url: `/api/files/${file.id}`, headers, payload: { confirmed: true } })).statusCode).toBe(204);
  expect((await app.inject({ url: `/api/files/${file.id}/download`, headers })).statusCode).toBe(404);
  fail = false; await app.close();
  const reopened = await open(); cleanups.push(() => reopened.close());
  expect(await readdir(join(dataDir, 'blobs'))).toEqual([]);
  expect((await reopened.inject({ url: '/api/files', headers })).json()).toEqual({ files: [] });
  await reopened.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Missing.drawio' } });
  await reopened.close();
  const blobs = await readdir(join(dataDir, 'blobs'));
  await rm(join(dataDir, 'blobs', blobs[0]!));
  await expect(open()).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
});

test('配置UTF8边界保存导入同限，JSON转义开销不误拒绝，超限下载原文不变', async () => {
  const { app, headers } = await setup({ maxBytes: 256 });
  const prefix = '<mxGraphModel><root><mxCell id="0" value="中';
  const suffix = '"/></root></mxGraphModel>';
  const content = prefix + 'x'.repeat(186) + suffix;
  const imported = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Boundary.drawio', content } });
  expect(imported.statusCode).toBe(201);
  expect(imported.json().size).toBe(256);
  const file = imported.json();
  const lease = (await app.inject({ method: 'POST', url: `/api/files/${file.id}/edit-session`, headers, payload: { windowId: 'boundary' } })).json();
  const url = `/api/files/${file.id}/content`;
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...lease, expectedRevision: 1, content } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...lease, expectedRevision: 2, content: content + ' ' } })).json().error.code).toBe('DOCUMENT_TOO_LARGE');
  expect((await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Oversized.drawio', content: content + ' ' } })).json().error.code).toBe('DOCUMENT_TOO_LARGE');
  expect((await app.inject({ url: `/api/files/${file.id}/download`, headers })).body).toBe(content);
  expect((await app.inject({ url, headers })).json().file.revision).toBe(2);
});

test('固定官方flowchart样例的压缩页与多页完整原文往返，解压炸弹和深层XML拒绝', async () => {
  const { app, headers } = await setup({ maxBytes: 16_384 });
  // Source: pinned draw.io v32.0.2 templates/flowcharts/flowchart_1.xml.
  const official = await readFile(new URL('../../../../vendor/drawio/src/main/webapp/templates/flowcharts/flowchart_1.xml', import.meta.url), 'utf8');
  const imported = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Official.drawio', content: official } });
  expect(imported.statusCode).toBe(201);
  expect((await app.inject({ url: `/api/files/${imported.json().id}/download`, headers })).body).toBe(official);
  const page = official.slice(official.indexOf('<diagram'), official.indexOf('</diagram>') + 10);
  const multi = `<mxfile>${page}${page.replace('6a731a19-8d31-9384-78a2-239565b7b9f0', 'second-page')}</mxfile>`;
  const second = await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Multipage.drawio', content: multi } });
  expect(second.statusCode).toBe(201);
  expect((await app.inject({ url: `/api/files/${second.json().id}/download`, headers })).body).toBe(multi);
  const bomb = deflateRawSync(Buffer.from(encodeURIComponent('<mxGraphModel>' + ' '.repeat(2_000_000) + '</mxGraphModel>'))).toString('base64');
  for (const content of [`<mxfile><diagram>${bomb}</diagram></mxfile>`, '<mxGraphModel>' + '<x>'.repeat(130) + '</x>'.repeat(130) + '</mxGraphModel>']) {
    expect((await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Invalid.drawio', content } })).json().error.code).toBe('INVALID_DOCUMENT');
  }
});

test('保存拒绝过期旧token及恶意XML，lease重新申请后新窗口可保存', async () => {
  const { app, headers, clock } = await setup();
  const file = (await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: 'Fence.drawio' } })).json();
  const contentUrl = `/api/files/${file.id}/content`; const leaseUrl = `/api/files/${file.id}/edit-session`;
  const content = (await app.inject({ url: contentUrl, headers })).json().content;
  const old = (await app.inject({ method: 'POST', url: leaseUrl, headers, payload: { windowId: 'old' } })).json();
  clock.value += 60_000;
  const next = (await app.inject({ method: 'POST', url: leaseUrl, headers, payload: { windowId: 'next' } })).json();
  expect((await app.inject({ method: 'PUT', url: contentUrl, headers, payload: { ...old, content, expectedRevision: 1 } })).json().error.code).toBe('LEASE_LOST');
  expect((await app.inject({ method: 'PUT', url: contentUrl, headers, payload: { ...next, content: '<mxGraphModel/>', expectedRevision: 1 } })).json().error.code).toBe('INVALID_DOCUMENT');
  expect((await app.inject({ url: contentUrl, headers })).json().file.revision).toBe(1);
  expect((await app.inject({ method: 'PUT', url: contentUrl, headers, payload: { ...next, content, expectedRevision: 1 } })).statusCode).toBe(200);
});

test('XML有效但缺少页面模型root或混入任意页面节点不能作为原生文档导入', async () => {
  const { app, headers } = await setup();
  for (const content of [
    '<mxfile><diagram><mxGraphModel/></diagram></mxfile>',
    '<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram><diagram><mxGraphModel/></diagram></mxfile>',
    '<mxfile><diagram><foo/><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
    '<mxGraphModel><foo><root/></foo></mxGraphModel>',
  ]) expect((await app.inject({ method: 'POST', url: '/api/files/import', headers, payload: { name: 'Invalid.drawio', content } })).json().error.code).toBe('INVALID_DOCUMENT');
});

test('正式API新建文件并读取完整空白原生文档', async () => {
  const { app, headers, auth } = await setup();
  const created = await app.inject({ method: 'POST', url: '/api/files', headers, payload: { name: ' Architecture.drawio ' } });
  expect(created.statusCode).toBe(201);
  const file = created.json();
  expect(file).toMatchObject({ name: 'Architecture.drawio', ownerId: auth.user.id, ownerUsername: 'admin', revision: 1 });
  const read = await app.inject({ url: `/api/files/${file.id}/content`, headers });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toEqual({ file, content: '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>' });
});
