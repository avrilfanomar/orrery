import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.RU_API?.trim() || 'http://127.0.0.1:4710';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5710,
    strictPort: true,
    proxy: { '/api': api },
  },
});
