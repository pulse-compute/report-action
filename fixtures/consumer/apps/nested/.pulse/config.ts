import { defineConfig } from '@pulse-compute/pulse'
export default defineConfig((_scope) => ({ pulse: { entry: 'src/index.ts', defaultProfile: 'ci', strict: true }, ci: { host: 'node', target: 'native', outDir: 'dist' } }))
