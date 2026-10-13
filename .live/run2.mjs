import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, name: 'live-probe', scriptPath: '.live/bundle.js', modules: true, compatibilityDate: '2026-10-13' }));
try {
  await mf.ready;
  const res = await mf.dispatchFetch('https://live.local/?sources=n12,mako&sample=3');
  console.log(JSON.stringify(await res.json(), null, 1));
} finally { await mf.dispose(); }
