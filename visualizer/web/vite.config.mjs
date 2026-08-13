import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  root: 'visualizer/web',
  plugins: [svelte()],
  build: { outDir: 'dist' },
  server: { proxy: { '/api': 'http://127.0.0.1:4488' } },
})
