/// <reference types='vitest' />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/board',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: './dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.js'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.{js,vue}'],
      // vue-shims.d.js is an editor type shim with no runtime code.
      exclude: ['src/**/*.test.js', 'src/vue-shims.d.js'],
      reporter: ['text', 'json'],
      reportsDirectory: '../../coverage/apps/board',
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
