import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.RU_API?.trim() || 'http://127.0.0.1:4710';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5710,
    strictPort: true,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        // The API takes a write only from its own origin (ADR 0010). A write from
        // a page this server served is the console's own, so it is forwarded as
        // one; a page from anywhere else keeps its Origin and is refused. This
        // trusts Host, so it is safe only while Vite's own host check
        // (`server.allowedHosts`) stays at its default and refuses rebound names.
        configure: (proxy) =>
          proxy.on('proxyReq', (outgoing, incoming) => {
            if (incoming.headers.origin === `http://${incoming.headers.host}`) outgoing.setHeader('origin', new URL(api).origin);
          }),
      },
    },
  },
});
