// ESLint v9 flat config for the dcd CLI.
// Replaces the old .eslintrc / .eslintignore pair.
// Keep this config lean: we're primarily interested in catching unused
// imports, obvious TS mistakes, and accidental `any` leaks in handwritten
// code. Generated schema types and the build output are excluded wholesale.

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
// This plugin ships as ESM with a `default` export under CJS interop.
const unicornPlugin =
  require('eslint-plugin-unicorn').default ?? require('eslint-plugin-unicorn');

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/types/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `unicorn` is only registered so legacy
    // `// eslint-disable-next-line unicorn/...` comments scattered through
    // the source resolve. We don't enable any rules from it.
    // `eslint-plugin-import` used to be registered here for the same reason,
    // but it was dropped: it dragged in minimatch@3 -> brace-expansion@1.x,
    // which has an unpatched DoS advisory (GHSA-mh99-v99m-4gvg, no 1.x
    // backport) and failed `pnpm audit`. No rules from it were ever enabled.
    plugins: {
      unicorn: unicornPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node runtime globals used by the CLI.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        ReadableStream: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The codebase uses `any` in a few gateway surfaces intentionally.
      '@typescript-eslint/no-explicit-any': 'off',
      // `require(...)` is used for lazy-loaded node builtins in a few places.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Chai's property-style assertions (`expect(x).to.be.true`) are
    // expression statements by design.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
