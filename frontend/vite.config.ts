import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // react-force-graph bundles aframe/aframe-extras which call
    // AFRAME.registerComponent() at module-init time.  When Vite
    // pre-bundles the whole chain into one file, AFRAME is not yet
    // defined when those registrations run → ReferenceError → lazy
    // import rejects → white screen.  Excluding it forces the browser
    // to follow the original ESM import order so aframe initialises
    // itself before aframe-extras tries to use it.
    exclude: ['react-force-graph'],
  },
})
