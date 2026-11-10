import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: process.env.EMAIL_OS_RUN_RENDERED === '1' ? [] : ['tests/**/*.rendered*.test.ts'],
  },
});
