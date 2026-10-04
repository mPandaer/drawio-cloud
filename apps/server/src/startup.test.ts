import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { describe, expect, test } from 'vitest';

async function temporaryPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

async function rejectedStartup(overrides: Record<string, string | undefined>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'drawio-rejected-'));
  const port = await temporaryPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/cli.ts'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, PUBLIC_ORIGIN: 'http://localhost:8080', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stdout = ''; let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`启动未退出：${stdout}\n${stderr}`)), 4000);
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.includes('服务已启动')) reject(new Error(`非法配置启动成功：${stdout}`));
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) reject(new Error(`非法配置进程成功退出：${stdout}`));
        else resolve({ code, stderr });
      });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}
describe('实际启动边界', () => {
  test('缺少外部入口拒绝启动，防止把内部监听地址用于同源校验', async () => {
    const result = await rejectedStartup({ PUBLIC_ORIGIN: undefined });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：PUBLIC_ORIGIN');
  });
  test('相对数据目录拒绝启动，避免工作目录改变数据落点', async () => {
    const result = await rejectedStartup({ DATA_DIR: 'data' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：DATA_DIR（必须提供绝对路径）');
  });
  test.each(['true', '*', '0.0.0.0/0', '::/0', '192.0.2.1/33', 'proxy.internal', '127.0.0.1,'])('不受控代理配置 %s 拒绝启动', async trusted => {
    const result = await rejectedStartup({ TRUSTED_PROXIES: trusted });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：TRUSTED_PROXIES');
  });
  test('空监听地址配置拒绝启动', async () => {
    const result = await rejectedStartup({ HOST: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：HOST');
  });
  test.each(['source', 'built', 'env-file'] as const)('合法配置从%s入口启动，显示外部入口与绝对数据目录，SIGTERM 后正常退出', async (entry) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'drawio-cli-'));
    const port = await temporaryPort();
    const serverDir = fileURLToPath(new URL('..', import.meta.url));
    if (entry !== 'source') await access(join(serverDir, 'dist/apps/server/src/cli.js')).catch(() => { throw new Error('缺少服务端产物，请先运行 pnpm --filter @drawio-cloud/server build 或 pnpm test'); });
    const configEnv = { DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://drawio.example', COOKIE_MODE: 'https' };
    if (entry === 'env-file') await writeFile(join(dataDir, '.env'), Object.entries(configEnv).map(([key, value]) => `${key}=${value}`).join('\n'));
    const args = entry === 'source' ? ['--import', 'tsx', 'apps/server/src/cli.ts'] : entry === 'built' ? ['dist/apps/server/src/cli.js'] : ['--env-file-if-exists=.env', join(serverDir, 'dist/apps/server/src/cli.js')];
    const child = spawn(process.execPath, args, {
      cwd: entry === 'source' ? process.cwd() : entry === 'built' ? serverDir : dataDir,
      env: { PATH: process.env.PATH, ...(entry === 'env-file' ? {} : configEnv) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let startupOutput = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('服务没有开始监听')), 4000);
        child.stdout.on('data', (data: Buffer) => { startupOutput += data.toString(); if (startupOutput.includes('服务已启动')) { clearTimeout(timer); resolve(); } });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('服务提前退出')); });
      });
      expect(startupOutput).toContain(`数据目录 ${dataDir}`);
      expect(startupOutput).toContain('外部入口 https://drawio.example');
      expect(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).toEqual({ status: 'ok' });
      expect(await (await fetch(`http://127.0.0.1:${port}/api/bootstrap`)).json()).toEqual({ initialized: false });
      expect((await fetch(`http://127.0.0.1:${port}/api/files`)).status).toBe(401);
      child.kill('SIGTERM');
      expect((await exited)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  test('空数据目录配置拒绝启动', async () => {
    const result = await rejectedStartup({ DATA_DIR: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：DATA_DIR');
  });
  test('非法监听端口拒绝启动', async () => {
    const result = await rejectedStartup({ PORT: '65536' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：PORT');
  });
  test('HTTP 入口不能启用 Secure Cookie', async () => {
    const result = await rejectedStartup({ COOKIE_MODE: 'https' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：COOKIE_MODE');
  });
  test('带路径的公开入口拒绝启动', async () => {
    const result = await rejectedStartup({ PUBLIC_ORIGIN: 'http://localhost:8080/path' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：PUBLIC_ORIGIN');
  });
  test('非法正文大小配置拒绝启动并显示中文原因', async () => {
    const result = await rejectedStartup({ MAX_DOCUMENT_BYTES: '0' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('配置错误：MAX_DOCUMENT_BYTES');
  });
});
