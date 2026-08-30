import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// The runtime server serves the built dist/ (single origin: API + UI together,
// which is what makes "web 端单独启动" and LAN mobile access the same artifact).
// Dev proxies /v1 to a local runtime server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    proxy: { "/v1": "http://127.0.0.1:3927" },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
})
