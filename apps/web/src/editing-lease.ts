import type { LeaseResponse, SaveFileRequest } from '@drawio-cloud/api-contract';
import type { ApiClient } from './api.js';

export function createEditingLease(api: ApiClient, id: string, initial: LeaseResponse) {
  let value = initial;
  return {
    get value() { return value; },
    async renew() { value = await api.renew(id, value); return value; },
    save: (request: SaveFileRequest, signal: AbortSignal) => api.save(id, { ...request, windowId: value.windowId, leaseToken: value.leaseToken }, signal),
    release: () => api.release(id, value),
  };
}
