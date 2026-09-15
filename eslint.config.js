import parser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
export default [{ ignores:['dist','node_modules'] }, { files:['src/**/*.{ts,tsx}'], languageOptions:{parser, parserOptions:{ecmaVersion:'latest',sourceType:'module',ecmaFeatures:{jsx:true}}}, plugins:{'@typescript-eslint':tsPlugin}, rules:{} }];