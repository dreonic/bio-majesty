import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: {
    // The public demo build (mode "mock") ships without source maps.
    sourcemap: mode !== 'mock',
    chunkSizeWarningLimit: 900,
  },
}));
