import { defineConfig } from 'vite';

export default defineConfig({
  // 0.0.0.0 — щоб гру можна було відкрити з телефона в тій самій мережі.
  server: { port: 8788, host: '0.0.0.0' },
  preview: { port: 8788, host: '0.0.0.0' },
  build: { target: 'es2022' },
});
