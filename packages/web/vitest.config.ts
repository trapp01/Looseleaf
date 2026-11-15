import { defineConfig } from 'vitest/config';

// Unit tests cover logic only; the Playwright suite in e2e/ drives the built app.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
