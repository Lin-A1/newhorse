#!/usr/bin/env bun

import { Script } from "@newhorse/script"
import path from "path"
import { fileURLToPath } from "url"
import { $ } from "bun"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

// Build the web app and produce an import map over its dist files, so the
// desktop sidecar (dist/node/node.js) can serve the embedded web UI on the
// LAN. Mirrors build.ts's createEmbeddedWebUIBundle; previously this file
// embedded an EMPTY map, which made any LAN/browser request fall back to the
// "The embedded web UI is not available" placeholder.
const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the sidecar`)
  const appDir = path.join(dir, "../app")
  const dist = path.join(appDir, "dist")
  await $`OPENCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")
const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    ...(embeddedFileMap ? { "opencode-web-ui.gen.ts": embeddedFileMap } : {}),
  },
})

console.log("Build complete")
