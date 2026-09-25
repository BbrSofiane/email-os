import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Slice 01 UI build. No remote assets are referenced; the native shell (integration lane)
// owns the Tauri CSP. This config only builds the web preview bundle.
export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
