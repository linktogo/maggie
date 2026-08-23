import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    // vite.config.*.timestamp-*.mjs / vitest.config.*.timestamp-*.mjs are
    // short-lived files Vite writes and deletes while loading its ESM
    // config. Excluded so `eslint .` can't race a concurrent build/test
    // run and crash with ENOENT trying to read one after Vite removes it
    // (this happens under `nx run-many`, which runs lint/test/build for a
    // project in parallel by default).
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
    ],
  },
  js.configs.recommended,
  // vue3-essential: error-prevention rules only, no opinionated template
  // formatting (those live in strongly-recommended/recommended).
  ...pluginVue.configs['flat/essential'],
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Single-word component names (Card, Column) are intentional in this app.
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // Node-side files: dev server, build/tooling config, and their tests.
    files: [
      'server.js',
      'server.test.js',
      'ciReader.test.js',
      'vite.config.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
