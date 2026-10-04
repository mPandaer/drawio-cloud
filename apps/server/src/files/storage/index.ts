import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CreateStorageModule, DocumentStorage } from '../../module-contracts.js';
import { ApiError } from '../../errors.js';
import { systemStorageIO } from './io.js';
import { createCoordinator } from './coordinator.js';

export const createStorageModule: CreateStorageModule = (context, options = {}) => {
  const io = options.io ?? systemStorageIO;
  const directory = join(context.config.dataDir, 'blobs');
  const path = (key: string) => {
    if (!/^[0-9a-f-]{36}\.blob$/.test(key)) throw new ApiError('STORAGE_FAILURE');
    return join(directory, key);
  };
  const coordinator = createCoordinator();
  const operations: DocumentStorage = {
    async prepare(content) {
      const key = `${randomUUID()}.blob`;
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await io.writeAndSync(temporary, content);
        await io.rename(temporary, path(key));
        await io.syncDirectory(directory);
        await io.syncDirectory(context.config.dataDir);
        return { key, size: Buffer.byteLength(content, 'utf8') };
      } catch (cause) {
        // Cleanup is best effort; startup reconciliation retries abandoned artifacts.
        await io.remove(temporary).catch(() => undefined);
        await io.remove(path(key)).catch(() => undefined);
        throw new ApiError('STORAGE_FAILURE', { cause });
      }
    },
    async read(key) {
      try { return await io.read(path(key)); }
      catch (cause) { throw new ApiError('STORAGE_FAILURE', { cause }); }
    },
    async reconcile(readReferencedKeys) {
      try {
        const referenced = new Set(readReferencedKeys());
        for (const key of referenced) await io.read(path(key));
        for (const key of await io.list(directory)) {
          if ((/^[0-9a-f-]{36}\.blob$/.test(key) || /^[0-9a-f-]{36}\.tmp$/.test(key)) && !referenced.has(key)) {
            try { await io.remove(join(directory, key)); }
            catch (error) {
              if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            }
          }
        }
        await io.syncDirectory(directory);
        await io.syncDirectory(context.config.dataDir);
      } catch (cause) { throw new ApiError('STORAGE_FAILURE', { cause }); }
    },
  };
  return {
    coordinator,
    storage: {
      prepare: content => coordinator.run(() => operations.prepare(content)),
      read: key => coordinator.run(() => operations.read(key)),
      reconcile: keys => coordinator.run(() => operations.reconcile(keys)),
    },
  };
};
