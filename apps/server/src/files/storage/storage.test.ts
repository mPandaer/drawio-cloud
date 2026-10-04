import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createApplication } from '../../app.js';
import { readConfig } from '../../config.js';
import { ApiError } from '../../errors.js';
import type { StorageIO } from '../../module-contracts.js';
import { createStorageModule } from './index.js';
import { systemStorageIO } from './io.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'drawio-storage-'));
  directories.push(path);
  return path;
}

// These routes adapt storage acceptance to HTTP; they implement neither file endpoints nor authorization.
async function acceptance(dataDir: string, io?: StorageIO, queued?: () => void) {
  return createApplication({ config: readConfig({ DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080' }),
    compose(context) {
      context.db.exec('CREATE TABLE IF NOT EXISTS storage_acceptance_refs (id TEXT PRIMARY KEY, blob_key TEXT NOT NULL)');
      const { storage, coordinator } = createStorageModule(context, { io });
      const references = () => (context.db.prepare('SELECT blob_key FROM storage_acceptance_refs').all() as { blob_key: string }[]).map(row => row.blob_key);
      return [{ register(app) {
        app.post<{ Body: { content: string; id: string } }>('/storage-acceptance/prepare-reference', request => coordinator.run(async () => {
          const blob = await storage.prepare(request.body.content);
          context.transactions.write(({ db }) => db.prepare('INSERT OR REPLACE INTO storage_acceptance_refs VALUES (?, ?)').run(request.body.id, blob.key));
          return blob;
        }));
        app.post<{ Body: { content: string } }>('/storage-acceptance/prepare', request => storage.prepare(request.body.content));
        app.get<{ Params: { key: string } }>('/storage-acceptance/blobs/:key', async request => ({ content: await storage.read(request.params.key) }));
        app.post<{ Body: { id: string; key: string } }>('/storage-acceptance/references', request => coordinator.run(async () => {
          context.transactions.write(({ db }) => db.prepare('INSERT OR REPLACE INTO storage_acceptance_refs VALUES (?, ?)').run(request.body.id, request.body.key));
          return { referenced: true };
        }));
        app.get<{ Params: { id: string } }>('/storage-acceptance/references/:id', request => coordinator.run(async () => {
          const row = context.db.prepare('SELECT blob_key FROM storage_acceptance_refs WHERE id = ?').get(request.params.id) as { blob_key: string } | undefined;
          if (!row) throw new ApiError('NOT_FOUND');
          return { content: await storage.read(row.blob_key) };
        }));
        app.get('/storage-acceptance/disk', async () => ({ entries: await systemStorageIO.list(join(dataDir, 'blobs')) }));
        app.delete<{ Params: { id: string } }>('/storage-acceptance/references/:id', request => coordinator.run(async () => {
          context.transactions.write(({ db }) => db.prepare('DELETE FROM storage_acceptance_refs WHERE id = ?').run(request.params.id));
          await storage.reconcile(references);
          return { deleted: true };
        }));
        app.post('/storage-acceptance/reconcile', async () => {
          const cleaning = storage.reconcile(references);
          queued?.();
          await cleaning;
          return { reconciled: true };
        });
      } }];
    },
  });
}

test.each(['writeAndSync', 'rename', 'syncDirectory'] as const)('HTTP storage acceptance rejects %s failure without changing a durable reference', async operation => {
  const dataDir = await directory();
  let app = await acceptance(dataDir);
  const previous = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>previous</mxfile>' } })).json();
  await app.inject({ method: 'POST', url: '/storage-acceptance/references', payload: { id: 'current', key: previous.key } });
  await app.close();
  app = await acceptance(dataDir, { ...systemStorageIO, [operation]: async () => { throw new Error(`injected ${operation}`); } });
  try {
    const response = await app.inject({ method: 'POST', url: '/storage-acceptance/prepare-reference', payload: { id: 'current', content: '<mxfile>new</mxfile>' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_FAILURE');
    expect((await app.inject('/storage-acceptance/references/current')).json()).toEqual({ content: '<mxfile>previous</mxfile>' });
  } finally { await app.close(); }
});

test('HTTP storage acceptance checks all references before cleanup and refuses missing content', async () => {
  const app = await acceptance(await directory());
  try {
    const orphan = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>orphan</mxfile>' } })).json();
    await app.inject({ method: 'POST', url: '/storage-acceptance/references', payload: { id: 'missing', key: '00000000-0000-4000-8000-000000000000.blob' } });
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).json().error.code).toBe('STORAGE_FAILURE');
    expect((await app.inject('/storage-acceptance/references/missing')).json().error.code).toBe('STORAGE_FAILURE');
    expect((await app.inject(`/storage-acceptance/blobs/${orphan.key}`)).json()).toEqual({ content: '<mxfile>orphan</mxfile>' });
  } finally { await app.close(); }
});

test('HTTP storage acceptance leaves deleted references absent when body cleanup fails and retries after reopen', async () => {
  const dataDir = await directory();
  let app = await acceptance(dataDir, { ...systemStorageIO, async remove() { throw new Error('injected unlink failure'); } });
  const blob = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>deleted</mxfile>' } })).json();
  await app.inject({ method: 'POST', url: '/storage-acceptance/references', payload: { id: 'deleted', key: blob.key } });
  expect((await app.inject({ method: 'DELETE', url: '/storage-acceptance/references/deleted' })).statusCode).toBe(503);
  expect((await app.inject('/storage-acceptance/references/deleted')).statusCode).toBe(404);
  await app.close();
  app = await acceptance(dataDir);
  try {
    expect((await app.inject('/storage-acceptance/references/deleted')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).statusCode).toBe(200);
    expect((await app.inject(`/storage-acceptance/blobs/${blob.key}`)).statusCode).toBe(503);
  } finally { await app.close(); }
});

test('HTTP storage acceptance cleans abandoned temp files after failed cleanup and reopen', async () => {
  const dataDir = await directory();
  let app = await acceptance(dataDir, { ...systemStorageIO,
    async writeAndSync(path) { await systemStorageIO.writeAndSync(path, '<partial'); throw new Error('injected write failure'); },
    async remove() { throw new Error('injected cleanup failure'); },
  });
  expect((await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile />' } })).statusCode).toBe(503);
  expect((await app.inject('/storage-acceptance/disk')).json().entries).toHaveLength(1);
  await app.close();
  app = await acceptance(dataDir);
  try {
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).statusCode).toBe(200);
    expect((await app.inject('/storage-acceptance/disk')).json()).toEqual({ entries: [] });
  } finally { await app.close(); }
});

test('HTTP storage acceptance holds preparation through reference commit against concurrent cleanup', async () => {
  const entered = gate();
  const resume = gate();
  const queued = gate();
  const app = await acceptance(await directory(), { ...systemStorageIO, async rename(from, to) {
    await systemStorageIO.rename(from, to);
    entered.release();
    await resume.promise;
  } }, queued.release);
  try {
    const preparing = app.inject({ method: 'POST', url: '/storage-acceptance/prepare-reference', payload: { id: 'current', content: '<mxfile>committed</mxfile>' } });
    await entered.promise;
    const cleaning = app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' }).then(response => response);
    await queued.promise;
    resume.release();
    expect((await preparing).statusCode).toBe(200);
    expect((await cleaning).statusCode).toBe(200);
    expect((await app.inject('/storage-acceptance/references/current')).json()).toEqual({ content: '<mxfile>committed</mxfile>' });
  } finally { resume.release(); await app.close(); }
});

test('HTTP storage acceptance treats an already-removed orphan as successful cleanup', async () => {
  const app = await acceptance(await directory(), { ...systemStorageIO, async remove(path) {
    await systemStorageIO.remove(path);
    throw Object.assign(new Error('already removed'), { code: 'ENOENT' });
  } });
  try {
    await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile />' } });
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).statusCode).toBe(200);
    expect((await app.inject('/storage-acceptance/disk')).json()).toEqual({ entries: [] });
  } finally { await app.close(); }
});

test('HTTP storage acceptance reports partial write failure and removes its temporary body', async () => {
  const app = await acceptance(await directory(), { ...systemStorageIO, async writeAndSync(path) {
    await systemStorageIO.writeAndSync(path, '<partial');
    throw new Error('injected write failure');
  } });
  try {
    const response = await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>complete</mxfile>' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('STORAGE_FAILURE');
    expect((await app.inject('/storage-acceptance/disk')).json()).toEqual({ entries: [] });
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).statusCode).toBe(200);
  } finally { await app.close(); }
});

test('HTTP storage acceptance lets an in-flight read finish before removing an abandoned blob', async () => {
  const entered = gate();
  const resume = gate();
  const queued = gate();
  let hold = false;
  const app = await acceptance(await directory(), { ...systemStorageIO, async read(path) {
    if (hold) { entered.release(); await resume.promise; }
    return systemStorageIO.read(path);
  } }, queued.release);
  try {
    const blob = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>reading</mxfile>' } })).json();
    hold = true;
    const reading = app.inject(`/storage-acceptance/blobs/${blob.key}`);
    await entered.promise;
    const cleaning = app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' }).then(response => response);
    await queued.promise;
    resume.release();
    expect((await reading).json()).toEqual({ content: '<mxfile>reading</mxfile>' });
    expect((await cleaning).statusCode).toBe(200);
    expect((await app.inject(`/storage-acceptance/blobs/${blob.key}`)).statusCode).toBe(503);
  } finally { resume.release(); await app.close(); }
});

test('HTTP storage acceptance reconciles after reopen, retaining references and removing abandoned blobs', async () => {
  const dataDir = await directory();
  let app = await acceptance(dataDir);
  const kept = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>kept</mxfile>' } })).json();
  const abandoned = (await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>abandoned</mxfile>' } })).json();
  await app.inject({ method: 'POST', url: '/storage-acceptance/references', payload: { id: 'current', key: kept.key } });
  await app.close();
  app = await acceptance(dataDir);
  try {
    expect((await app.inject({ method: 'POST', url: '/storage-acceptance/reconcile' })).statusCode).toBe(200);
    expect((await app.inject('/storage-acceptance/references/current')).json()).toEqual({ content: '<mxfile>kept</mxfile>' });
    expect((await app.inject(`/storage-acceptance/blobs/${abandoned.key}`)).json().error.code).toBe('STORAGE_FAILURE');
  } finally { await app.close(); }
});

test('HTTP storage acceptance prepares distinct immutable complete UTF-8 blobs', async () => {
  const app = await acceptance(await directory());
  try {
    const first = await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>中文</mxfile>' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().size).toBe(23);
    const second = await app.inject({ method: 'POST', url: '/storage-acceptance/prepare', payload: { content: '<mxfile>new</mxfile>' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().key).not.toBe(first.json().key);
    expect((await app.inject(`/storage-acceptance/blobs/${first.json().key}`)).json()).toEqual({ content: '<mxfile>中文</mxfile>' });
    expect((await app.inject(`/storage-acceptance/blobs/${second.json().key}`)).json()).toEqual({ content: '<mxfile>new</mxfile>' });
  } finally { await app.close(); }
});
