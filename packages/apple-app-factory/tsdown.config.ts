import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/*.ts'],
  platform: 'node',
  format: 'esm',
  fixedExtension: false,
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: true,
  copy: [
    { from: '../../README.md', to: '.' },
    { from: '../../LICENSE', to: '.' },
    { from: '../../LICENSE', to: 'skills/apple-app-factory' },
  ],
});
