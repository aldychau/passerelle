import { defineConfig } from 'vite';

// Le même outil que l’interface ; le contrat partagé est embarqué, les dépendances Node restent externes.
export default defineConfig({
  ssr: { noExternal: ['@passerelle/shared'] },
  build: {
    ssr: 'src/index.ts',
    outDir: 'dist',
    target: 'node22',
    minify: false,
    sourcemap: true,
    rolldownOptions: { output: { entryFileNames: 'index.js' } },
  },
});
