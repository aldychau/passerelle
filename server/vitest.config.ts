import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Les tests de sécurité rendent de vrais composants de l'interface (web/src) : même transformation JSX et même alias que Vite.
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, '../web/src') } },
  test: {
    environment: 'node',
    // Chaque fichier ouvre PostgreSQL en mémoire : limiter les instances PGlite simultanées.
    maxWorkers: 2,
    include: ['test/**/*.test.ts'],
    // scrypt (64 Mio par empreinte) est volontairement lent : on laisse de la marge
    testTimeout: 30_000,
  },
});
