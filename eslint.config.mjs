import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['.context/**', 'out/**', 'node_modules/**'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module'
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
