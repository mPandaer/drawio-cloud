import { createHash, randomBytes } from 'node:crypto';
import type { AcquireLeaseRequest } from '../../../../packages/api-contract/src/index.js';
import type { CreateEditingModule } from '../module-contracts.js';
import { ApiError } from '../errors.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const createEditingModule: CreateEditingModule = (context, { identity, resolveIdentity }) => {
  const leases = {
    requireLease(tx: import('../module-contracts.js').Transaction, actor: import('../module-contracts.js').Identity, fileId: string, credentials: import('../../../../packages/api-contract/src/index.js').LeaseCredentials) {
      identity.revalidate(tx, actor);
      if (typeof credentials?.leaseToken !== 'string' || typeof credentials.windowId !== 'string') throw new ApiError('LEASE_LOST');
      const row = tx.db.prepare('SELECT file_id FROM edit_leases WHERE file_id = ? AND user_id = ? AND session_id = ? AND window_id = ? AND token_hash = ? AND expires_at > ?').get(fileId, actor.user.id, actor.sessionId, credentials.windowId, digest(credentials.leaseToken), context.clock.now());
      if (!row) throw new ApiError('LEASE_LOST');
    },
    requireUnoccupied(tx: import('../module-contracts.js').Transaction, fileId: string) {
      if (tx.db.prepare('SELECT file_id FROM edit_leases WHERE file_id = ? AND expires_at > ?').get(fileId, context.clock.now())) throw new ApiError('FILE_OCCUPIED');
    },
  };
  return { leases, module: { register(app) {
    for (const method of ['PATCH', 'DELETE'] as const) app.route<{ Params: { id: string }; Body: import('../../../../packages/api-contract/src/index.js').LeaseCredentials }>({
      method, url: '/api/files/:id/edit-session', async handler(request, reply) {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        const expiresAt = context.transactions.write(tx => {
          leases.requireLease(tx, actor, request.params.id, request.body);
          const file = tx.db.prepare('SELECT owner_id FROM files WHERE id = ?').get(request.params.id) as { owner_id: string } | undefined;
          if (!file) throw new ApiError('NOT_FOUND');
          identity.authorizeFile(tx, actor, file.owner_id);
          if (method === 'DELETE') { tx.db.prepare('DELETE FROM edit_leases WHERE file_id = ?').run(request.params.id); return 0; }
          const expiry = context.clock.now() + 60_000;
          tx.db.prepare('UPDATE edit_leases SET expires_at = ? WHERE file_id = ?').run(expiry, request.params.id);
          return expiry;
        });
        return method === 'DELETE' ? reply.code(204).send() : { windowId: request.body.windowId, leaseToken: request.body.leaseToken, expiresAt };
      },
    });
    app.post<{ Params: { id: string }; Body: AcquireLeaseRequest }>('/api/files/:id/edit-session', async (request, reply) => {
      const actor = resolveIdentity(request);
      identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
      const windowId = request.body?.windowId;
      if (typeof windowId !== 'string' || !windowId.trim() || windowId.length > 200) throw new ApiError('INVALID_REQUEST');
      const result = context.transactions.write(tx => {
        identity.revalidate(tx, actor);
        const file = tx.db.prepare('SELECT owner_id FROM files WHERE id = ?').get(request.params.id) as { owner_id: string } | undefined;
        if (!file) throw new ApiError('NOT_FOUND');
        identity.authorizeFile(tx, actor, file.owner_id);
        leases.requireUnoccupied(tx, request.params.id);
        const leaseToken = randomBytes(32).toString('base64url');
        const expiresAt = context.clock.now() + 60_000;
        tx.db.prepare('INSERT INTO edit_leases(file_id, user_id, session_id, window_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, window_id = excluded.window_id, token_hash = excluded.token_hash, expires_at = excluded.expires_at').run(request.params.id, actor.user.id, actor.sessionId, windowId, digest(leaseToken), expiresAt);
        return { windowId, leaseToken, expiresAt };
      });
      return reply.code(201).send(result);
    });
  } } };
};
