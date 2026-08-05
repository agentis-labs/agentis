import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.AGENTIS_API_PROXY_TARGET ?? 'http://127.0.0.1:3737';
const socketTarget = apiTarget.replace(/^http/, 'ws');
const webPort = Number(process.env.PORT ?? process.env.AGENTIS_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/v1': apiTarget,
      // §PERF-BOOT — the "is the server up?" probe. Without this entry the SPA
      // fallback answered /healthz with index.html 200 in dev, so the probe
      // reported a downed API as reachable and the app logged the operator out.
      '/healthz': apiTarget,
      '/socket.io': {
        target: socketTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (/[\\/]node_modules[\\/](?:socket\.io-client|engine\.io-client|socket\.io-parser|engine\.io-parser)[\\/]/.test(id)) {
            return 'vendor-realtime';
          }
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
});
