import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Express API (backend/). Override with API_URL when it runs elsewhere.
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3010';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // livekit-client alone is ~540 kB; it is only loaded by the demo page.
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5180,
    strictPort: true,
    proxy: { '/api': { target: API_URL, changeOrigin: true } },
  },
});
