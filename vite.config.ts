import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: parseInt(process.env.PORT || '1420'),
    strictPort: true,
    allowedHosts: ['dev.pkcollection.net'],
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})





