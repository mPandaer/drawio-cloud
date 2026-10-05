import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';

export interface ServerConfig {
  dataDir: string;
  publicOrigin: string;
  allowedOrigins: string[];
  cookieSecure: boolean;
  maxDocumentBytes: number;
  bodyLimit: number;
  host: string;
  port: number;
  trustedProxies: string[];
}
export class ConfigurationError extends Error {
  constructor(key: string) { super(`配置错误：${key}`); }
}
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = env.MAX_DOCUMENT_BYTES ?? '20971520';
  const maxDocumentBytes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes <= 0 || maxDocumentBytes > (Number.MAX_SAFE_INTEGER - 65536) / 6) {
    throw new ConfigurationError('MAX_DOCUMENT_BYTES');
  }
  let origin: URL;
  try { origin = new URL(env.PUBLIC_ORIGIN ?? ''); }
  catch { throw new ConfigurationError('PUBLIC_ORIGIN'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new ConfigurationError('PUBLIC_ORIGIN');
  }
  const cookieMode = env.COOKIE_MODE ?? origin.protocol.slice(0, -1);
  if (!['http', 'https'].includes(cookieMode) || `${cookieMode}:` !== origin.protocol) {
    throw new ConfigurationError('COOKIE_MODE');
  }
  const allowedOrigins = [origin.origin];
  if (env.ALLOWED_ORIGINS !== undefined) {
    for (const value of env.ALLOWED_ORIGINS.split(',')) {
      let additional: URL;
      try { additional = new URL(value.trim()); }
      catch { throw new ConfigurationError('ALLOWED_ORIGINS'); }
      if (additional.protocol !== origin.protocol || additional.username || additional.password || additional.pathname !== '/' || additional.search || additional.hash) {
        throw new ConfigurationError('ALLOWED_ORIGINS');
      }
      if (!allowedOrigins.includes(additional.origin)) allowedOrigins.push(additional.origin);
    }
  }
  const portRaw = env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError('PORT');
  const dataDir = env.DATA_DIR;
  if (!dataDir?.trim() || dataDir.includes('\0') || !isAbsolute(dataDir)) throw new ConfigurationError('DATA_DIR（必须提供绝对路径）');
  const host = env.HOST ?? '0.0.0.0';
  if (!host.trim() || host !== host.trim() || /[\s/\0]/.test(host)) throw new ConfigurationError('HOST');
  const trustedProxies = env.TRUSTED_PROXIES?.split(',').map(value => value.trim()) ?? [];
  for (const proxy of trustedProxies) {
    const [address, prefix, extra] = proxy.split('/');
    const family = isIP(address ?? '');
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new ConfigurationError('TRUSTED_PROXIES（仅允许明确 IP 或非零 CIDR）');
    }
  }
  return {
    dataDir, publicOrigin: origin.origin, allowedOrigins,
    cookieSecure: cookieMode === 'https', maxDocumentBytes, bodyLimit: maxDocumentBytes * 6 + 65536,
    host, port, trustedProxies,
  };
}
