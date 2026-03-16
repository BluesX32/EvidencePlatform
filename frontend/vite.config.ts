import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // 3d-force-graph (pure three.js, no aframe/VR) pulls in CJS packages
    // like ngraph.forcelayout and ngraph.graph.  Explicitly including it
    // here ensures Vite pre-bundles those CJS deps into proper ESM so the
    // browser can load them.  We no longer use react-force-graph directly.
    include: ['3d-force-graph'],
  },
})
