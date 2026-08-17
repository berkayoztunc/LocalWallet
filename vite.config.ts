import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** Where Privacy Cash ships its proving key and circuit, and where we serve them. */
const CIRCUIT_SOURCE = "node_modules/privacycash/circuit2";
const CIRCUIT_ROUTE = "/circuit2/";

/**
 * The hashing library Privacy Cash proves with locates its WASM relative to
 * its own module URL, which after bundling is the built chunk. Copying the
 * files in beside it is what the library's own install notes prescribe.
 */
const HASHER_WASM_SOURCE = "node_modules/@lightprotocol/hasher.rs/dist";
const HASHER_WASM_FILES = ["light_wasm_hasher_bg.wasm", "hasher_wasm_simd_bg.wasm"];

/**
 * Make Privacy Cash's binary assets reachable at runtime.
 *
 * Two sets, neither of which can be `import`ed: the proving key and circuit,
 * which the prover fetches by URL, and the hashing library's WASM, which it
 * resolves relative to its own module. Together they are ~22 MB of generated
 * output that both packages already ship, so they are streamed out of
 * `node_modules` in development and copied into the bundle at build time
 * rather than committed to this repository.
 */
function privacyCashAssets(): Plugin {
  const wasmFor = (url: string): string | null => {
    const name = path.basename(url);
    if (url.startsWith(CIRCUIT_ROUTE)) return path.join(CIRCUIT_SOURCE, name);
    if (HASHER_WASM_FILES.includes(name)) return path.join(HASHER_WASM_SOURCE, name);
    return null;
  };

  return {
    name: "privacy-cash-assets",

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split("?")[0];
        // basename keeps a crafted path from walking out of these directories.
        const file = url ? wasmFor(url) : null;
        if (!file) return next();

        let size: number;
        try {
          size = (await fs.stat(file)).size;
        } catch {
          return next();
        }

        // The prover streams the proving key in pieces, so range requests are
        // not optional here — a dev server that ignores them loads a 16 MB
        // file in full on every proof, or fails outright.
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Number(range[2]) : size - 1;

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", String(end - start + 1));
        if (range) {
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }

        createReadStream(file, { start, end })
          .on("error", () => next())
          .pipe(res);
      });
    },

    async writeBundle(options) {
      const outDir = options.dir ?? "dist";

      const circuits = path.join(outDir, "circuit2");
      await fs.mkdir(circuits, { recursive: true });
      for (const name of await fs.readdir(CIRCUIT_SOURCE)) {
        await fs.copyFile(path.join(CIRCUIT_SOURCE, name), path.join(circuits, name));
      }

      // The hasher resolves its WASM against its own bundled chunk, so these
      // belong beside the emitted chunks rather than at the bundle root.
      const assets = path.join(outDir, "assets");
      await fs.mkdir(assets, { recursive: true });
      for (const name of HASHER_WASM_FILES) {
        await fs.copyFile(path.join(HASHER_WASM_SOURCE, name), path.join(assets, name));
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    // Privacy Cash encrypts its notes with Node's `crypto`. Without a shim
    // Vite stubs the import out and every decrypt throws at runtime, so this
    // is load-bearing, not a convenience. Limited to the modules the SDK
    // actually reaches for, to keep the rest of the app browser-native.
    nodePolyfills({ include: ["buffer", "crypto", "stream", "util", "vm"] }),
    privacyCashAssets(),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
