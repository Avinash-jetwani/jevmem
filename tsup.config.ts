import { defineConfig } from "tsup";

export default defineConfig([
  // Library entry: dependencies stay external (installed by npm alongside the package).
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    dts: { entry: { index: "src/index.ts" } },
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  // CLI entry (hooks, daemon, MCP server): every dependency is bundled in, so the file runs without node_modules.
  // The Claude Code plugin is installed from the npm tarball, and Claude Code installs a plugin's dependencies only when
  // it ships an npm lockfile; a self-contained CLI does not depend on that.
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    sourcemap: true,
    clean: false,
    splitting: false,
    noExternal: [/.*/],
    // Bundled CommonJS dependencies call require(); give the ES module one.
    banner: { js: 'import { createRequire as __jevmemCreateRequire } from "node:module";\nconst require = __jevmemCreateRequire(import.meta.url);' },
  },
]);
