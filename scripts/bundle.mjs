/**
 * Bundle the CLI into a single self-contained ESM file.
 *
 * The published package declares no runtime dependencies: resolving a ~150
 * package tree was the dominant cost of a cold `npx` install, far outweighing
 * the time to download and run the server itself. Bundling turns that tree
 * into one file, so a consumer install is a single registry request.
 *
 * Everything is bundled, including the MCP SDK, which pulls an HTTP server
 * stack that stdio transport never touches; the bundler drops what is unused.
 */
import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Some bundled dependencies are CommonJS and call `require` at runtime, which
// does not exist in an ESM output file unless we recreate it.
const banner =
  'import{createRequire as __createRequire}from"node:module";' +
  'const require=__createRequire(import.meta.url);';

await build({
  entryPoints: [join(repoRoot, "src", "cli.ts")],
  outfile: join(repoRoot, "bundle", "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: banner },
  logLevel: "info",
});
