import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import sirv from 'sirv';

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, envDir, 'API_PROXY_TARGET');
  return {
  envDir,
  plugins: [react(), {
    name: 'local-editor-entry',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/editor') return next();
        response.writeHead(308, { Location: `/editor/${url.search}` });
        response.end();
      });
      server.middlewares.use('/editor/', sirv(fileURLToPath(new URL('../../build/editor', import.meta.url)), {
        dev: true,
        setHeaders(response) {
          response.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
          response.setHeader('Cache-Control', 'no-cache');
        },
      }));
      server.middlewares.use('/editor/', (_request, response) => {
        response.writeHead(404);
        response.end('Editor asset not found; run pnpm build:editor.');
      });
    },
  }],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': process.env.API_PROXY_TARGET ?? env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
  };
});
