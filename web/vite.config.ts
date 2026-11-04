import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    // En développement l'API tourne à part (npm run dev) ; même origine vue du navigateur.
    proxy: { '/api': { target: 'https://127.0.0.1:3030', secure: false }, '/oauth': { target: 'https://127.0.0.1:3030', secure: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
