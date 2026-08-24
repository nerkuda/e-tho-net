/**
 * ESLint flat config (ESLint 9).
 *
 * Shared TypeScript rules across all workspaces (@etn/shared, @etn/server,
 * @etn/client). Run from the repo root: `npm run lint`.
 *
 * Per-package specifics (electron renderer globals, test files, etc.) can be
 * layered later via additional config objects when those packages get code.
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    // Global ignores — build/runtime artefacts (mirrors .gitignore + .prettierignore).
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/.nyc_output/**',
      '**/*.db',
      '**/*.db-wal',
      '**/*.db-shm',
      '**/package-lock.json',
    ],
  },

  // Base JS recommended rules.
  js.configs.recommended,

  // TypeScript recommended (parser + plugin), already scoped to TS files.
  ...tseslint.configs.recommended,

  {
    // TypeScript sources across all workspaces — ESM modules.
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Strict but pragmatic: recommended TS set + allow underscore-prefixed unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    // Node.js ESM scripts (e.g. client/scripts/rebuild-native.mjs).
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },

  {
    // CommonJS scripts (this config file, .cjs tests like
    // client/tests/window-bounds-restart.test.cjs).
    files: ['*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      // CommonJS legitimately uses require().
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
