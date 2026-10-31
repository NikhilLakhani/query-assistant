import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  z.url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/'
      );
    }, 'VITE_API_BASE_URL must be an HTTP(S) origin')
    .parse(env.VITE_API_BASE_URL ?? 'http://localhost:3001');
  const apiOrigin = new URL(env.VITE_API_BASE_URL ?? 'http://localhost:3001')
    .origin;
  return {
    plugins: [
      react(),
      {
        name: 'production-content-security-policy',
        apply: 'build',
        transformIndexHtml() {
          return [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ${apiOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'`,
              },
              injectTo: 'head-prepend',
            },
          ];
        },
      },
    ],
  };
});
