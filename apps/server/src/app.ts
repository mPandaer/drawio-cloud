import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { errorDefinitions, type HealthResponse, type ErrorCode } from '../../../packages/api-contract/src/index.js';
import type { ServerConfig } from './config.js';
import { openDatabase } from './database.js';
import { ApiError, errorResponse } from './errors.js';
import type { ApplicationModule, Clock, ModuleContext, ComposeModules } from './module-contracts.js';

export interface ApplicationOptions {
  config: ServerConfig;
  clock?: Clock;
  modules?: readonly ApplicationModule[];
  compose?: ComposeModules;
}
export async function createApplication(options: ApplicationOptions) {
  const db = openDatabase(options.config.dataDir);
  const app = Fastify({ bodyLimit: options.config.bodyLimit, trustProxy: options.config.trustedProxies.length ? options.config.trustedProxies : false });
  app.addHook('onClose', async () => { db.close(); });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', "frame-ancestors 'self'");
    return payload;
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(errorResponse('NOT_FOUND')));
  app.setErrorHandler((error, request, reply) => {
    let code: ErrorCode = 'INTERNAL_ERROR';
    if (error instanceof ApiError) code = error.code;
    else if (error instanceof Error && 'statusCode' in error) {
      if (error.statusCode === 413) code = 'REQUEST_TOO_LARGE';
      else if (error.statusCode === 415) code = 'UNSUPPORTED_MEDIA_TYPE';
      else if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) code = 'INVALID_REQUEST';
    }
    const frameworkStatus = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = code === 'INVALID_REQUEST' && typeof frameworkStatus === 'number' && frameworkStatus >= 400 && frameworkStatus < 500
      ? frameworkStatus : errorDefinitions[code].status;
    if (status >= 500) request.log.error(error);
    reply.code(status).send(errorResponse(code));
  });
  app.get('/api/health', async (): Promise<HealthResponse> => ({ status: 'ok' }));
  const context: ModuleContext = {
    config: options.config, clock: options.clock ?? { now: () => Date.now() }, db,
    transactions: {
      write(work) { return db.transaction(() => {
        const result = work({ db });
        if (result && typeof result === 'object' && 'then' in result) throw new Error('事务不允许异步操作');
        return result;
      }).immediate(); },
    },
  };
  try {
    await app.register(cookie);
    const composed = await options.compose?.(context) ?? [];
    for (const module of [...composed, ...options.modules ?? []]) await module.register(app, context);
    await app.ready();
    return app;
  } catch (error) { await app.close(); throw error; }
}
