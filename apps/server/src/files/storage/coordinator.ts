import { AsyncLocalStorage } from 'node:async_hooks';
import type { StorageCoordinator } from '../../module-contracts.js';

export function createCoordinator(): StorageCoordinator {
  const scope = new AsyncLocalStorage<{ active: boolean }>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (scope.getStore()?.active) return work();
      const result = tail.then(() => {
        const owner = { active: true };
        return scope.run(owner, async () => {
          try { return await work(); }
          finally { owner.active = false; }
        });
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
