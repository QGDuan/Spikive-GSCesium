import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // Local sample data remains available to the development server only. Production artifacts and
  // customer installers must never inherit files from public/, especially local PLY datasets.
  publicDir: command === 'serve' ? 'public' : false
}));
