import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.AGENTIS_API_PROXY_TARGET ?? 'http://127.0.0.1:3737';
const socketTarget = apiTarget.replace(/^http/, 'ws');
const webPort = Number(process.env.AGENTIS_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/v1': apiTarget,
      '/socket.io': {
        target: socketTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
