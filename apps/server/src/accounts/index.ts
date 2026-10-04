import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import type { FastifyRequest } from 'fastify';
import type { User, CredentialsRequest, ChangePasswordRequest, ResetPasswordRequest, SetUserStatusRequest } from '../../../../packages/api-contract/src/accounts.js';
import type { CreateAccountsModule, Identity, IdentityAuthority, RequestCredentials } from '../module-contracts.js';
import { ApiError } from '../errors.js';

export const createAccountsModule: CreateAccountsModule = (context, options = {}) => {
  const argon = options.argon2 ?? { hash, verify };
  const costs = { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
  const encodePassword = (password: string) => argon.hash(password, costs);
  const dummyHash = encodePassword(randomBytes(32).toString('base64url'));
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');
  type UserRow = Omit<User, 'disabled'> & { disabled: number; password_hash: string };
  const publicUser = (row: UserRow): User => ({ id: row.id, username: row.username, role: row.role, disabled: Boolean(row.disabled) });
  const resolveIdentity = (request: FastifyRequest): Identity => {
    const token = request.cookies['drawio_session'];
    if (!token) throw new ApiError('UNAUTHENTICATED');
    const row = context.db.prepare(`SELECT u.*, s.id AS session_id, s.csrf_token, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(digest(token)) as (UserRow & { session_id: string; csrf_token: string; expires_at: number }) | undefined;
    if (!row || row.expires_at <= context.clock.now() || row.disabled) throw new ApiError('UNAUTHENTICATED');
    return { user: publicUser(row), sessionId: row.session_id, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  };
  const initialized = () => Boolean(context.db.prepare('SELECT id FROM initialization WHERE id = 1').get());
  const attempts = new Map<string, { count: number; until: number }>();
  const throttle = (key: string, limit = 5) => {
    const now = context.clock.now();
    for (const [address, entry] of attempts) if (entry.until <= now) attempts.delete(address);
    const entry = attempts.get(key) ?? { count: 0, until: now + 60_000 };
    if (entry.count >= limit || (!attempts.has(key) && attempts.size >= 10_000)) throw new ApiError('RATE_LIMITED');
    entry.count++;
    attempts.set(key, entry);
  };
  const requireOrigin = (origin?: string) => { if (origin !== context.config.publicOrigin) throw new ApiError('INVALID_ORIGIN'); };
  const credentials = (body: unknown): CredentialsRequest => {
    if (!body || typeof body !== 'object') throw new ApiError('INVALID_REQUEST');
    const { username, password } = body as CredentialsRequest;
    if (typeof username !== 'string' || !username.trim() || username.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(username)
      || typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new ApiError('INVALID_REQUEST');
    return { username: username.trim(), password };
  };
  const identity: IdentityAuthority = {
    requireMutation(actor: Identity, input: RequestCredentials) {
      requireOrigin(input.origin);
      if (!input.csrfToken || input.csrfToken !== actor.csrfToken) throw new ApiError('INVALID_CSRF');
    },
    revalidate(tx, actor) {
      const row = tx.db.prepare(`SELECT u.*, s.csrf_token, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?`).get(actor.sessionId, actor.user.id) as (UserRow & { csrf_token: string; expires_at: number }) | undefined;
      if (!row || row.disabled || row.expires_at <= context.clock.now() || row.csrf_token !== actor.csrfToken) throw new ApiError('UNAUTHENTICATED');
      return { user: publicUser(row), sessionId: actor.sessionId, csrfToken: row.csrf_token, expiresAt: row.expires_at };
    },
    authorizeFile(tx, actor, ownerId) {
      const current = identity.revalidate(tx, actor);
      if (current.user.role !== 'admin' && current.user.id !== ownerId) throw new ApiError('FORBIDDEN');
    },
  };
  const mutationActor = (request: FastifyRequest) => {
    const actor = resolveIdentity(request);
    const csrfToken = request.headers['x-csrf-token'];
    identity.requireMutation(actor, { origin: request.headers.origin, csrfToken: typeof csrfToken === 'string' ? csrfToken : undefined });
    return actor;
  };
  const requireAdmin = (actor: Identity) => { if (actor.user.role !== 'admin') throw new ApiError('FORBIDDEN'); };
  return {
    module: { async register(app) {
      await dummyHash;
      app.get('/api/admin/users', async request => {
        requireAdmin(resolveIdentity(request));
        return { users: (context.db.prepare('SELECT * FROM users ORDER BY created_at, id').all() as UserRow[]).map(publicUser) };
      });
      app.post('/api/admin/users', async (request, reply) => {
        const actor = mutationActor(request); requireAdmin(actor);
        const input = credentials(request.body);
        const passwordHash = await encodePassword(input.password);
        const user: User = { id: randomUUID(), username: input.username, role: 'user', disabled: false };
        context.transactions.write(tx => {
          requireAdmin(identity.revalidate(tx, actor));
          if (tx.db.prepare('SELECT id FROM users WHERE username_key = ?').get(input.username.toLowerCase())) throw new ApiError('USERNAME_EXISTS');
          tx.db.prepare('INSERT INTO users(id, username, username_key, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, user.username, user.username.toLowerCase(), passwordHash, user.role, context.clock.now());
        });
        return reply.code(201).send(user);
      });
      app.patch<{ Params: { id: string }; Body: SetUserStatusRequest }>('/api/admin/users/:id', async (request) => {
        const actor = mutationActor(request); requireAdmin(actor);
        if (typeof request.body?.disabled !== 'boolean') throw new ApiError('INVALID_REQUEST');
        return context.transactions.write(tx => {
          requireAdmin(identity.revalidate(tx, actor));
          const row = tx.db.prepare('SELECT * FROM users WHERE id = ?').get(request.params.id) as UserRow | undefined;
          if (!row) throw new ApiError('NOT_FOUND');
          if (request.body.disabled && row.role === 'admin' && !row.disabled) {
            const count = tx.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0").get() as { count: number };
            if (count.count <= 1) throw new ApiError('LAST_ADMIN');
          }
          tx.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(Number(request.body.disabled), row.id);
          if (request.body.disabled) {
            tx.db.prepare('DELETE FROM edit_leases WHERE user_id = ?').run(row.id);
            tx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
          }
          return publicUser({ ...row, disabled: Number(request.body.disabled) });
        });
      });
      app.post<{ Params: { id: string }; Body: ResetPasswordRequest }>('/api/admin/users/:id/password', async (request, reply) => {
        const actor = mutationActor(request); requireAdmin(actor);
        credentials({ username: 'password-validation', password: request.body?.newPassword });
        const passwordHash = await encodePassword(request.body.newPassword);
        context.transactions.write(tx => {
          requireAdmin(identity.revalidate(tx, actor));
          const changed = tx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, request.params.id);
          if (!changed.changes) throw new ApiError('NOT_FOUND');
          tx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(request.params.id);
        });
        return reply.code(204).send();
      });
      app.post<{ Body: ChangePasswordRequest }>('/api/auth/password', async (request, reply) => {
        const actor = mutationActor(request);
        const input = request.body;
        if (!input || typeof input.currentPassword !== 'string') throw new ApiError('INVALID_REQUEST');
        credentials({ username: actor.user.username, password: input.newPassword });
        const row = context.db.prepare('SELECT * FROM users WHERE id = ?').get(actor.user.id) as UserRow;
        if (!await argon.verify(row.password_hash, input.currentPassword)) throw new ApiError('INVALID_CREDENTIALS');
        const passwordHash = await encodePassword(input.newPassword);
        context.transactions.write(tx => {
          identity.revalidate(tx, actor);
          const changed = tx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(passwordHash, actor.user.id, row.password_hash);
          if (!changed.changes) throw new ApiError('UNAUTHENTICATED');
          tx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(actor.user.id);
        });
        reply.clearCookie('drawio_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: context.config.cookieSecure, maxAge: 0 });
        return reply.code(204).send();
      });
      app.post('/api/auth/logout', async (request, reply) => {
        const actor = mutationActor(request);
        context.transactions.write(({ db }) => { db.prepare('DELETE FROM sessions WHERE id = ?').run(actor.sessionId); });
        reply.clearCookie('drawio_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: context.config.cookieSecure, maxAge: 0 });
        return reply.code(204).send();
      });
      app.get('/api/auth/me', async request => { const { user, csrfToken, expiresAt } = resolveIdentity(request); return { user, csrfToken, expiresAt }; });
      app.post('/api/auth/login', async (request, reply) => {
        requireOrigin(request.headers.origin);
        throttle(`login:ip:${request.ip}`, 25);
        let input: CredentialsRequest;
        try { input = credentials(request.body); }
        catch (error) { throttle('login:global', 250); throw error; }
        throttle(`login:account:${input.username.toLowerCase()}`);
        throttle('login:global', 250);
        const row = context.db.prepare('SELECT * FROM users WHERE username_key = ?').get(input.username.toLowerCase()) as UserRow | undefined;
        const valid = await argon.verify(row?.password_hash ?? await dummyHash, input.password);
        if (!row || !valid) throw new ApiError('INVALID_CREDENTIALS');
        if (row.disabled) throw new ApiError('ACCOUNT_DISABLED');
        const token = randomBytes(32).toString('base64url');
        const csrfToken = randomBytes(32).toString('base64url');
        const expiresAt = context.clock.now() + 604_800_000;
        context.transactions.write(({ db }) => {
          const current = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id) as UserRow | undefined;
          if (!current || current.password_hash !== row.password_hash) throw new ApiError('INVALID_CREDENTIALS');
          if (current.disabled) throw new ApiError('ACCOUNT_DISABLED');
          db.prepare('INSERT INTO sessions(id, token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), digest(token), row.id, csrfToken, context.clock.now(), expiresAt);
        });
        reply.setCookie('drawio_session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: context.config.cookieSecure, maxAge: 604800, expires: new Date(expiresAt) });
        return { user: publicUser(row), csrfToken, expiresAt };
      });
      app.get('/api/bootstrap', async () => ({ initialized: initialized() }));
      app.post<{ Body: CredentialsRequest }>('/api/bootstrap', async (request, reply) => {
        requireOrigin(request.headers.origin);
        if (initialized()) throw new ApiError('ALREADY_INITIALIZED');
        throttle(`bootstrap:${request.ip}`);
        credentials(request.body);
        const passwordHash = await encodePassword(request.body.password);
        context.transactions.write(({ db }) => {
          if (initialized()) throw new ApiError('ALREADY_INITIALIZED');
          db.prepare('INSERT INTO users(id, username, username_key, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(randomUUID(), request.body.username.trim(), request.body.username.trim().toLowerCase(), passwordHash, 'admin', context.clock.now());
          db.prepare('INSERT INTO initialization(id, initialized_at) VALUES (1, ?)').run(context.clock.now());
        });
        return reply.code(201).send({ initialized: true });
      });
    } },
    identity,
    resolveIdentity,
  };
};
