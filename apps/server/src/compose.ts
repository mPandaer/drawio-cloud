import { createAccountsModule } from './accounts/index.js';
import { createEditingModule } from './editing/index.js';
import { createStorageModule } from './files/storage/index.js';
import { createFilesModule } from './files/index.js';
import type { ComposeModules } from './module-contracts.js';

export const composeBackend: ComposeModules = context => {
  const accounts = createAccountsModule(context);
  const editing = createEditingModule(context, accounts);
  const storage = createStorageModule(context);
  const files = createFilesModule(context, { ...accounts, ...editing, ...storage });
  return [accounts.module, editing.module, files.module];
};
