// ESLint flat config (ESLint v9+). 规则集保持最小集（V2.3.6 / implementation-plan §PR-0.2）：
// - @typescript-eslint/recommended-type-checked
// - @typescript-eslint/no-floating-promises: error  （核心门禁）
// - @typescript-eslint/no-unused-vars: error       （未使用导入/变量，真实缺陷信号）
//
// 其余在现有代码中触发较多但不影响「未捕获 Promise」门禁语义的高级规则（unsafe / 风格化 / 模板）
// 暂设为 warn，CI 不阻断；后续 PR 按需升级为 error（避免 PR-0.2 变成大扫除）。
//
// 不引入风格化规则（prettier、import-order 等）。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 核心门禁（V2.3.6 / PR-0.2 明确）
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': 'error',

      // 现有代码触发的「噪声」规则：先 warn，不阻断 CI
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-implied-eval': 'warn',

      // 与 strict TS 重叠
      'no-unused-vars': 'off',
    },
  },
);
