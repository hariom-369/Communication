// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Security- and architecture-relevant restrictions shared by every TypeScript file.
 * See docs/security.md §4 and §12.
 */
const restrictedSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Rendering HTML strings is forbidden (docs/security.md §4). Render from a parsed AST.',
  },
  {
    selector: "CallExpression[callee.name='eval'], NewExpression[callee.name='Function']",
    message: 'Dynamic code evaluation is forbidden.',
  },
];

const restrictedProperties = [
  {
    object: 'Math',
    property: 'random',
    message: 'Math.random is not a CSPRNG. Use crypto.getRandomValues / node:crypto.',
  },
  {
    object: 'window',
    property: 'localStorage',
    message: 'Browser storage policy: see docs/security.md §12.',
  },
  {
    object: 'window',
    property: 'sessionStorage',
    message: 'Browser storage policy: see docs/security.md §12.',
  },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Conflicts with the `noPropertyAccessFromIndexSignature` compiler option, which wins.
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...restrictedSyntax],
      'no-restricted-properties': ['error', ...restrictedProperties],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Browser storage policy: see docs/security.md §12.' },
        { name: 'sessionStorage', message: 'Browser storage policy: see docs/security.md §12.' },
      ],
    },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['eslint.config.js', '**/vitest.config.ts', '**/vitest.integration.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
