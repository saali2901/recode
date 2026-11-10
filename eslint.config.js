import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', '.bench', 'coverage', 'node_modules', 'test/fixtures/build'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Test doubles for external CLIs run as plain Node scripts.
    files: ['test/helpers/*.mjs', 'scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        performance: 'readonly',
      },
    },
  },
  {
    // Tests assert on fixtures they just created; non-null assertions keep them readable.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // API responses are untyped JSON in these tests.
    files: ['test/integration/server.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
