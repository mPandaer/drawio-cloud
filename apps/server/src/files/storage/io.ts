import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageIO } from '../../module-contracts.js';

export const systemStorageIO: StorageIO = {
  async writeAndSync(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
  },
  rename,
  async syncDirectory(path) {
    const directory = await open(path, 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
  },
  read: path => readFile(path, 'utf8'),
  async list(directory) {
    await mkdir(directory, { recursive: true });
    return readdir(directory);
  },
  remove: unlink,
};
