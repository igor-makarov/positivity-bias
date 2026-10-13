import configuration from './websites.json' with { type: 'json' };
import { fetchPublisher, safeError } from './src/ingest.js';
import { validateWebsites } from './src/news.js';
const kan = validateWebsites(configuration).find((s) => s.id === 'kan');
const url = 'https://www.kan.org.il/content/kan-news/politic/1108970/';
try {
  const r = await fetchPublisher(url, kan);
  console.log('OK', r.url, r.body.length);
} catch (e) { console.log('FAIL', e?.name, e?.message, safeError(e), e?.cause?.code || e?.cause?.message); }
// raw fetch test
try {
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'PositivityBias/0.1 (+https://github.com/igor-makarov/positivity-bias)', Accept: 'text/html' } });
  console.log('raw', res.status, res.headers.get('location'));
} catch (e) { console.log('raw FAIL', e?.name, e?.message, e?.cause?.code || e?.cause?.message); }
