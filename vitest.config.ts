import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tests/**/*.{test,spec}.{ts,tsx}', 'packages/**/tests/**/*.{test,spec}.{ts,tsx}'], testTimeout: 15_000, hookTimeout: 15_000, pool: 'forks' } })
