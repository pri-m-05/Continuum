import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        background: 'src/background/background.ts',
        content: 'src/content/contentScript.ts',
        popup: 'src/popup/index.html',
        options: 'src/options/index.html'
      },
      output: {
        entryFileNames: asset => `[[name]].js` // MV3 requires predictable names
      }
    }
  }
});