import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4111',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // V2 的 SSE eventsUrl 由后端返回真实路由 `/v1/...`。该路径不能走
      // `/api` rewrite，开发服务器必须原样转发到 Mastra 后端。
      '/v1': {
        target: 'http://localhost:4111',
        changeOrigin: true,
      },
    },
  },
})
