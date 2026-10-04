import { createApplication } from '../app.js';
import { readConfig } from '../config.js';
import { createAccountsModule } from '../accounts/index.js';
import { createEditingModule } from '../editing/index.js';
import { createFilesModule } from './index.js';
import { createStorageModule } from './storage/index.js';
import { systemStorageIO } from './storage/io.js';

// Test process: interruption stays at system I/O, around the real SQLite commit.
let armed = false;
const stage = process.env.CRASH_STAGE;
const app = await createApplication({ config: readConfig(), compose(context) {
  const accounts = createAccountsModule(context);
  const editing = createEditingModule(context, accounts);
  const storage = createStorageModule(context, { io: { ...systemStorageIO,
    async syncDirectory(path) {
      await systemStorageIO.syncDirectory(path);
      if (armed && stage === 'before') { process.send?.('before'); await new Promise(() => undefined); }
    },
    async remove(path) {
      if (armed && stage === 'after') { process.send?.('after'); await new Promise(() => undefined); }
      await systemStorageIO.remove(path);
    },
  } });
  const files = createFilesModule(context, { ...accounts, ...editing, ...storage });
  return [accounts.module, editing.module, files.module];
} });
await app.listen({ host: '127.0.0.1', port: 0 });
process.on('message', message => { if (message === 'arm') { armed = true; process.send?.('armed'); } });
process.send?.({ port: (app.server.address() as { port: number }).port });
