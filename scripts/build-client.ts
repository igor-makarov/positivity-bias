import { build } from 'esbuild';
await build({ entryPoints: ['client/app.ts', 'client/theme.ts'], outdir: 'public',
  bundle: true, format: 'iife', target: 'es2022', minify: true });
