import { randomUUID } from 'node:crypto';
import type { DrawingFile, CreateFileRequest, SaveFileRequest, RenameFileRequest, DeleteFileRequest, ImportFileRequest, FilesQuery } from '../../../../packages/api-contract/src/index.js';
import type { FilesDependencies, FilesModule, ModuleContext, Identity, Transaction } from '../module-contracts.js';
import { ApiError } from '../errors.js';
import { validateDocument } from './document.js';

const blank = '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
type Row = { id: string; owner_id: string; owner_username: string; name: string; blob_key: string; revision: number; size: number; created_at: number; updated_at: number };
const metadata = (row: Row): DrawingFile => ({ id: row.id, ownerId: row.owner_id, ownerUsername: row.owner_username, name: row.name, revision: row.revision, size: row.size, createdAt: row.created_at, updatedAt: row.updated_at });
export function createFilesModule(context: ModuleContext, dependencies: FilesDependencies): FilesModule {
  const { identity, resolveIdentity, storage, coordinator } = dependencies;
  const references = () => (context.db.prepare('SELECT blob_key FROM files').all() as { blob_key: string }[]).map(row => row.blob_key);
  const get = (tx: Transaction, actor: Identity, id: string) => {
    identity.revalidate(tx, actor);
    const row = tx.db.prepare('SELECT f.*, u.username AS owner_username FROM files f JOIN users u ON u.id = f.owner_id WHERE f.id = ?').get(id) as Row | undefined;
    if (!row) throw new ApiError('NOT_FOUND');
    identity.authorizeFile(tx, actor, row.owner_id);
    return row;
  };
  const nameOf = (name: unknown) => {
    if (typeof name !== 'string' || !name.trim() || /[/\\\u0000-\u001f\u007f]/.test(name) || name.length > 255) throw new ApiError('INVALID_NAME');
    return name.trim();
  };
  const saves = { async save(actor: Identity, fileId: string, request: SaveFileRequest) {
    if (typeof request?.content !== 'string' || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw new ApiError('INVALID_REQUEST');
    validateDocument(request.content, context.config.maxDocumentBytes);
    return coordinator.run(async () => {
      const blob = await storage.prepare(request.content);
      try {
        return context.transactions.write(tx => {
          const row = get(tx, actor, fileId);
          dependencies.leases.requireLease(tx, actor, fileId, request);
          if (row.revision !== request.expectedRevision) throw new ApiError('REVISION_CONFLICT');
          const updatedAt = context.clock.now();
          tx.db.prepare('UPDATE files SET blob_key = ?, size = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(blob.key, blob.size, updatedAt, fileId, request.expectedRevision);
          return { revision: row.revision + 1, size: blob.size, updatedAt };
        });
      } finally {
        await storage.reconcile(references).catch(() => undefined);
      }
    });
  } };
  return {
    saves,
    module: { async register(app) {
      await storage.reconcile(references);
      app.get<{ Querystring: FilesQuery }>('/api/files', async request => {
        const actor = resolveIdentity(request);
        if (request.query.search !== undefined && typeof request.query.search !== 'string') throw new ApiError('INVALID_REQUEST');
        return coordinator.run(async () => context.transactions.write(tx => {
          const current = identity.revalidate(tx, actor);
          const rows = tx.db.prepare('SELECT f.*, u.username AS owner_username FROM files f JOIN users u ON u.id = f.owner_id WHERE (? = \'admin\' OR f.owner_id = ?) ORDER BY f.updated_at DESC, f.id').all(current.user.role, current.user.id) as Row[];
          return { files: rows.filter(row => row.name.toLowerCase().includes((request.query.search ?? '').toLowerCase())).map(metadata) };
        }));
      });
      app.patch<{ Params: { id: string }; Body: RenameFileRequest }>('/api/files/:id', async request => {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        const name = nameOf(request.body?.name);
        return coordinator.run(async () => context.transactions.write(tx => {
          const row = get(tx, actor, request.params.id);
          if (tx.db.prepare('SELECT id FROM files WHERE owner_id = ? AND name_key = ? AND id != ?').get(row.owner_id, name.toLowerCase(), row.id)) throw new ApiError('NAME_EXISTS');
          tx.db.prepare('UPDATE files SET name = ?, name_key = ?, updated_at = ? WHERE id = ?').run(name, name.toLowerCase(), context.clock.now(), row.id);
          return metadata(get(tx, actor, row.id));
        }));
      });
      app.delete<{ Params: { id: string }; Body: DeleteFileRequest }>('/api/files/:id', async (request, reply) => {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        if (request.body?.confirmed !== true) throw new ApiError('INVALID_REQUEST');
        await coordinator.run(async () => {
          context.transactions.write(tx => {
            get(tx, actor, request.params.id);
            dependencies.leases.requireUnoccupied(tx, request.params.id);
            tx.db.prepare('DELETE FROM files WHERE id = ?').run(request.params.id);
          });
          await storage.reconcile(references).catch(() => undefined);
        });
        return reply.code(204).send();
      });
      app.get<{ Params: { id: string } }>('/api/files/:id/download', async (request, reply) => {
        const actor = resolveIdentity(request);
        const result = await coordinator.run(async () => {
          const row = context.transactions.write(tx => get(tx, actor, request.params.id));
          return { name: row.name, content: await storage.read(row.blob_key) };
        });
        return reply.type('application/xml; charset=utf-8').header('content-disposition', `attachment; filename="drawing.drawio"; filename*=UTF-8''${encodeURIComponent(result.name)}`).send(result.content);
      });
      for (const url of ['/api/files', '/api/files/import']) app.post<{ Body: CreateFileRequest | ImportFileRequest }>(url, async (request, reply) => {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        const name = nameOf(request.body?.name);
        const content = url.endsWith('/import') ? (request.body as ImportFileRequest).content : blank;
        if (url.endsWith('/import') && !/\.drawio$/i.test(name)) throw new ApiError('INVALID_DOCUMENT');
        validateDocument(content, context.config.maxDocumentBytes);
        const result = await coordinator.run(async () => {
          const blob = await storage.prepare(content);
          try {
            return context.transactions.write(tx => {
              identity.revalidate(tx, actor);
              if (tx.db.prepare('SELECT id FROM files WHERE owner_id = ? AND name_key = ?').get(actor.user.id, name.toLowerCase())) throw new ApiError('NAME_EXISTS');
              const id = randomUUID(); const now = context.clock.now();
              tx.db.prepare('INSERT INTO files(id, owner_id, name, name_key, blob_key, revision, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id, actor.user.id, name, name.toLowerCase(), blob.key, blob.size, now, now);
              return metadata(get(tx, actor, id));
            });
          } finally {
            await storage.reconcile(references).catch(() => undefined);
          }
        });
        return reply.code(201).send(result);
      });
      app.put<{ Params: { id: string }; Body: SaveFileRequest }>('/api/files/:id/content', async request => {
        const actor = resolveIdentity(request);
        identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: request.headers['x-csrf-token'] as string });
        return saves.save(actor, request.params.id, request.body);
      });
      app.get<{ Params: { id: string } }>('/api/files/:id/content', async request => {
        const actor = resolveIdentity(request);
        return coordinator.run(async () => {
          const row = context.transactions.write(tx => get(tx, actor, request.params.id));
          return { file: metadata(row), content: await storage.read(row.blob_key) };
        });
      });
    } },
  };
}
