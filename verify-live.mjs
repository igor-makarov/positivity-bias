// Live adapter verification (NOT committed; network-dependent).
import configuration from './websites.json' with { type: 'json' };
import { ingestSource } from './src/ingest.js';
import { validateWebsites } from './src/news.js';

const now = Date.now();
for (const source of validateWebsites(configuration)) {
  try {
    const result = await ingestSource(source, [], now);
    console.log(`\n### ${source.id} (${source.domain}) state=${result.status.state} received=${result.status.received}`);
    for (const e of result.status.errors) console.log('  error:', e.feed, e.code);
    const byCat = new Map();
    for (const a of result.articles) {
      const key = a.categories.join('|') || '(none)';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(a);
    }
    for (const [cat, list] of byCat) {
      const a = list[0];
      console.log(`  cat[${cat}] n=${list.length} pub=${a.publishedAt} hosts=${new Set(list.map(x => new URL(x.url).hostname)).size}`);
      console.log(`    title: ${a.originalHeadline.slice(0, 80)}`);
      console.log(`    desc : ${String(a.description || '').slice(0, 60)}`);
      console.log(`    url  : ${a.url}`);
    }
  } catch (e) {
    console.log(`### ${source.id} THREW ${e?.stack || e}`);
  }
}
