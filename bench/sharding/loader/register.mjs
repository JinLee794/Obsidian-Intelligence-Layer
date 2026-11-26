// No-install loader for the sharding bench.
//
// The worktree has no node_modules (installing was not authorised), so this
// runs `src/*.ts` directly on Node's built-in type stripping:
//   - `./x.js` specifiers resolve to `./x.ts` (and `./x.mjs` to `./x.mts`) when
//     only the TypeScript file exists, matching tsc's Node16 resolution;
//   - `gray-matter` maps to a local YAML-subset shim (see gray-matter.mjs);
//   - bm25.ts's one non-erasable construct (a constructor parameter property)
//     is rewritten in memory at load time. The file on disk is untouched.
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHIM = new URL("./gray-matter.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "gray-matter") {
      return { url: SHIM, format: "module", shortCircuit: true };
    }
    const ext = specifier.endsWith(".mjs") ? ".mjs" : specifier.endsWith(".js") ? ".js" : null;
    if (
      ext &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      const js = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(js))) {
        const tsExt = ext === ".mjs" ? ".mts" : ".ts";
        const ts = new URL(`${specifier.slice(0, -ext.length)}${tsExt}`, context.parentURL);
        if (existsSync(fileURLToPath(ts))) {
          return { url: ts.href, format: "module-typescript", shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/src/bm25.ts")) {
      const original = readFileSync(fileURLToPath(url), "utf8");
      const anchor =
        /private readonly include(: \(node: GraphNode\) => boolean = \(\) => true,\s*\)\s*\{)/;
      if (!anchor.test(original)) throw new Error("bm25.ts rewrite anchor not found");
      const source = original.replace(anchor, "include$1 this.include = include;");
      return { format: "module-typescript", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
