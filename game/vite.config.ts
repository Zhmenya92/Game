import { defineConfig } from 'vite';

export default defineConfig({
  // 0.0.0.0 — щоб гру можна було відкрити з телефона в тій самій мережі.
  // strictPort — щоб vite падав, а не тихо переповзав на сусідній порт:
  // саме так він одного разу зайняв 8790 і сховав бекенд.
  server: { port: 8788, host: '0.0.0.0', strictPort: true },
  preview: { port: 8788, host: '0.0.0.0', strictPort: true },
  build: { target: 'es2022' },
});
