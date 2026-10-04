import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { expect, test } from 'vitest';

async function withEntry(check: (origin: string) => Promise<void>) {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    await check(`http://127.0.0.1:${address.port}`);
  } finally { await server.close(); }
}

test('本地入口提供真实编辑器 HTML 和相对脚本而不回退到产品页面', async () => {
  await withEntry(async origin => {
    const html = await fetch(`${origin}/editor/`);
    expect(html.headers.get('content-type')).toMatch(/text\/html/);
    expect(await html.text()).toContain('js/bootstrap.js');
    const script = await fetch(`${origin}/editor/js/PreConfig.js`);
    expect(script.headers.get('content-type')).toMatch(/(?:text|application)\/javascript/);
    expect(await script.text()).toContain('DRAWIO_BASE_URL');
  });
});

test('本地编辑器入口允许同源 iframe 并要求资源重新验证', async () => {
  await withEntry(async origin => {
    for (const path of ['/editor/', '/editor/js/PreConfig.js', '/editor/styles/grapheditor.css']) {
      const response = await fetch(`${origin}${path}`);
      expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
      expect(response.headers.get('cache-control')).toMatch(/no-cache|no-store|max-age=0/);
      if (path.endsWith('.css')) expect(response.headers.get('content-type')).toMatch(/text\/css/);
      await response.arrayBuffer();
    }
  });
});

test('本地入口将 editor 归一化为尾斜杠并保留 iframe 参数', async () => {
  await withEntry(async origin => {
    const response = await fetch(`${origin}/editor?embed=1&proto=json`, { redirect: 'manual' });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/editor/?embed=1&proto=json');
  });
});
