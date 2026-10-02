import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/workspace/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
