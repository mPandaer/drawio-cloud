import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User, LeaseCredentials, SaveFileRequest, SaveFileResponse } from '../../../packages/api-contract/src/index.js';
import type { ServerConfig } from './config.js';

export interface Clock { now(): number }
export interface Transaction {
  readonly db: Database.Database;
}
// Work must be synchronous; filesystem I/O completes before entering the write transaction.
export interface Transactions { write<T>(work: (tx: Transaction) => T extends PromiseLike<unknown> ? never : T): T }
export interface Identity { user: User; sessionId: string; csrfToken: string; expiresAt: number }
export interface RequestCredentials { csrfToken?: string; origin?: string }
// Accounts alone parses cookies and authenticates session tokens via IdentityResolver.
// Downstream modules receive Identity, never raw tokens; mutation checks bind CSRF to that identity.
export interface IdentityAuthority {
  requireMutation(identity: Identity, credentials: RequestCredentials): void;
  revalidate(tx: Transaction, identity: Identity): Identity;
  authorizeFile(tx: Transaction, identity: Identity, ownerId: string): void;
}
// Editing validates leases in the same transaction used by file mutations.
export interface LeaseAuthority {
  requireLease(tx: Transaction, identity: Identity, fileId: string, credentials: LeaseCredentials): void;
  requireUnoccupied(tx: Transaction, fileId: string): void;
}
// Storage owns coordination across prepare/commit/read/cleanup; callers never expose blob paths.
export interface StorageCoordinator {
  run<T>(work: () => Promise<T>): Promise<T>;
}
export interface PreparedBlob { key: string; size: number }
export interface DocumentStorage {
  prepare(content: string): Promise<PreparedBlob>;
  read(key: string): Promise<string>;
  // Reads current references only after entering the coordinator critical section.
  reconcile(readReferencedKeys: () => readonly string[]): Promise<void>;
}
// Fault injection is limited to system I/O; the storage worker chooses the filesystem adapter.
export interface StorageIO {
  writeAndSync(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  read(path: string): Promise<string>;
  list(directory: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}
export interface FileSaveService {
  save(identity: Identity, fileId: string, request: SaveFileRequest): Promise<SaveFileResponse>;
}
export interface ModuleContext {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly db: Database.Database;
  readonly transactions: Transactions;
}
export interface ApplicationModule {
  // Factories close over injected authorities; registration completes before listen.
  register(app: FastifyInstance, context: ModuleContext): void | Promise<void>;
}
export type IdentityResolver = (request: FastifyRequest) => Identity;

// Parent owns these shared signatures and the composition root; workers own their factory implementations.
// Accounts revokes leases by SQL in its own transaction (sessions cascade + user lease deletion),
// so creating accounts does not depend on editing at runtime.
export interface AccountsModule {
  module: ApplicationModule;
  identity: IdentityAuthority;
  resolveIdentity: IdentityResolver;
}
// Optional system boundary; production uses the native Argon2 implementation.
export interface Argon2Port {
  hash: typeof import('argon2').hash;
  verify: typeof import('argon2').verify;
}
export type CreateAccountsModule = (context: ModuleContext, options?: { argon2?: Argon2Port }) => AccountsModule;
export interface EditingDependencies {
  identity: IdentityAuthority;
  resolveIdentity: IdentityResolver;
}
export interface EditingModule { module: ApplicationModule; leases: LeaseAuthority }
export type CreateEditingModule = (context: ModuleContext, dependencies: EditingDependencies) => EditingModule;
// Pure services: storage has no HTTP routes and no ApplicationModule registration.
export interface StorageModule {
  storage: DocumentStorage;
  coordinator: StorageCoordinator;
}
export type CreateStorageModule = (context: ModuleContext, options?: { io?: StorageIO }) => StorageModule;
export interface FilesDependencies extends EditingDependencies, StorageModule { leases: LeaseAuthority }
export interface FilesModule { module: ApplicationModule; saves: FileSaveService }
export type CreateFilesModule = (context: ModuleContext, dependencies: FilesDependencies) => FilesModule;
// Parent constructs accounts -> editing and storage -> files, then returns the accounts, editing and files route modules.
// Composition finishes before routes register; startup reconciliation belongs to the files composition root, which supplies live database references before serving writes.
export type ComposeModules = (context: ModuleContext) => readonly ApplicationModule[] | Promise<readonly ApplicationModule[]>;
