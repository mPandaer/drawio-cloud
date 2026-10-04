import { readConfig } from './config.js';
import { createApplication } from './app.js';
import { composeBackend } from './compose.js';

try {
  const config = readConfig();
  const app = await createApplication({ config, compose: composeBackend });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) { await app.close(); throw error; }
  console.info(`服务已启动：监听 ${app.server.address() ? `${config.host}:${config.port}` : ''}；外部入口 ${config.publicOrigin}；数据目录 ${config.dataDir}；Cookie ${config.cookieSecure ? 'HTTPS Secure' : 'HTTP'}`);
  const shutdown = () => { void app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : '服务启动失败');
  process.exitCode = 1;
}
