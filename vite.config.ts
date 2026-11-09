import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The built UI is served by "recode ui" from dist/web.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: { '/api': 'http://127.0.0.1:7878' },
  },
});
