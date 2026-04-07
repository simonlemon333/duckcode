import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
