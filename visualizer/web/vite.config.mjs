import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  root: 'visualizer/web',
  plugins: [svelte()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4488',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers?.origin
            const host = req.headers?.host
            if (!origin || !host) return
            let originHost
            try {
              originHost = new URL(origin).host
            } catch {
              return
            }
            if (originHost === host) proxyReq.setHeader('origin', 'http://127.0.0.1:4488')
          })
        },
      },
    },
  },
})
