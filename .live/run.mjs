import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
await build({ entryPoints: ['.live/probe.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: '.live/bundle.js' });
const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, name: 'live-probe', scriptPath: '.live/bundle.js', modules: true, compatibilityDate: '2026-10-13' }));
try {
  await mf.ready;
  const res = await mf.dispatchFetch('https://live.local/?sources=ynet,kan&sample=3');
  console.log(JSON.stringify(await res.json(), null, 1));
} finally { await mf.dispose(); }
