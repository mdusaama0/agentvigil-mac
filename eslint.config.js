import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // Several modules declare a binding and assign it later so closures
      // defined earlier in the same scope can capture it by reference.
      'prefer-const': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
