// Builds Obsidian Web Clipper's programmatic API for plain Node.js.
// Upstream scripts/build-api.mjs keeps defuddle external, and Node cannot take the
// named export createMarkdownContent from the CommonJS module defuddle/full, so the
// API is bundled here with defuddle inside. Same entry, aliases and defines as upstream.
import * as esbuild from 'esbuild';
import path from 'node:path';

const root = process.cwd();

await esbuild.build({
  entryPoints: [path.join(root, 'src/api.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(root, 'dist/api.mjs'),
  external: ['dayjs'],
  define: { DEBUG_MODE: 'false' },
  alias: { 'webextension-polyfill': path.join(root, 'src/utils/cli-stubs.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
