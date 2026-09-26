// Build step for the expert Dockerfile: one esbuild bundle, same settings as the Lambda like-for-like
// configuration except that a container has no runtime-provided AWS SDK, so the SDK is bundled in.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  sourcemap: false,
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
  }
});
