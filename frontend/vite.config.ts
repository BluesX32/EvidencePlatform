import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// When running inside Docker the backend is reachable via the service name.
// Locally it's on localhost:8000.  Override with API_TARGET env var if needed.
// docker-compose sets API_TARGET=http://backend:8000 for the frontend service.
const apiTarget = process.env.API_TARGET ?? 'http://localhost:8000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // 3d-force-graph (pure three.js, no aframe/VR) pulls in CJS packages
    // like ngraph.forcelayout and ngraph.graph.  Explicitly including it
    // here ensures Vite pre-bundles those CJS deps into proper ESM so the
    // browser can load them.  We no longer use react-force-graph directly.
    include: ['3d-force-graph', '@dagrejs/dagre'],
  },
  server: {
    // Proxy all API requests to the backend so the browser never makes
    // cross-origin requests.  Works for local dev and Docker/AWS alike.
    proxy: {
      '/auth':     { target: apiTarget, changeOrigin: true },
      '/projects': { target: apiTarget, changeOrigin: true },
      '/health':   { target: apiTarget, changeOrigin: true },
    },
  },
})
