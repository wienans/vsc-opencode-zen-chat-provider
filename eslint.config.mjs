import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			ecmaversion: 2022,
			sourceType: 'module'
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'off'
		}
	}
);
