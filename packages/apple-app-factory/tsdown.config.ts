import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts'],
  root: 'src',
  unbundle: true,
  deps: { alwaysBundle: ['@earendil-works/pi-schema'] },
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
    { from: '../../LICENSE', to: 'skills/apphx' },
    { from: '../../vendor/pi-schema/LICENSE', to: 'dist/vendor/pi-schema' },
    { from: '../../vendor/pi-schema/LICENSES/typebox-LICENSE', to: 'dist/vendor/pi-schema/LICENSES' },
  ],
});
