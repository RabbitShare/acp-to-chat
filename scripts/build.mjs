import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts", "src/extension.ts", "src/sessions.ts", "src/acp.ts"],
  outbase: "src",
  outdir: "dist",
  bundle: true,
  platform: "node",
  // jsonc-parser's UMD wrapper passes require as a value; bundle its ESM entry instead.
  mainFields: ["module", "main"],
  format: "cjs",
  target: "es2022",
  external: ["vscode"],
  sourcemap: true,
  sourcesContent: false
});
