import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  server: { proxy: { '/media': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000', '/socket.io': { target: 'http://127.0.0.1:3000', ws: true } } },
})
