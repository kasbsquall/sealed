import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Runtime dependencies stay external; the repo's own reference code
// (../../agents) is bundled in, so the package needs nothing from the repo.
const external = ["ethers", "express", "zod", /^@modelcontextprotocol\/sdk/];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "node20",
    platform: "node",
    external,
    splitting: false,
    sourcemap: false,
    clean: true,
  },
  {
    entry: { mcp: "src/mcp/bin.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    external,
    splitting: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { __SEALED_VERSION__: JSON.stringify(version) },
  },
]);
