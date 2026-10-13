import configuration from './websites.json' with { type: 'json' };
import { articleMetadata, parseNewsSitemap, validDate } from './src/news.js';
import { validateWebsites } from './src/news.js';
import { fetchPublisher } from './src/ingest.js';
const kan = validateWebsites(configuration).find((s) => s.id === 'kan');
const { body: sitemap } = await fetchPublisher(kan.newsSitemap, kan);
const candidates = parseNewsSitemap(sitemap, kan).slice(0, 4);
console.log('sitemap candidates:', candidates.length);
for (const c of candidates) {
  const { body: html, url } = await fetchPublisher(c.url, kan);
  const scripts = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const meta = {};
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    const prop = /(?:property|name)="(og:title|og:description|description|article:section|article:published_time)"/i.exec(tag)?.[1];
    const content = /content="([^"]*)"/i.exec(tag)?.[1];
    if (prop && content) meta[prop] = content.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  const data = articleMetadata(scripts, meta);
  const pub = validDate(data.publishedAt || c.publishedAt);
  console.log(`\nsitemapHeadline: ${c.headline.slice(0,70)}`);
  console.log(`  metaHeadline : ${String(data.headline).slice(0,70)}`);
  console.log(`  categories   : ${JSON.stringify(data.categories)}`);
  console.log(`  publishedAt  : ${pub}`);
  console.log(`  desc         : ${String(data.description).slice(0,60)}`);
}
