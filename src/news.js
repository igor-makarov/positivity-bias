import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { array, plainText, text } from './text.js';

export { articleMetadata, plainText } from './text.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });

export function canonicalUrl(value, source, syndication = false) {
  try {
    const url = new URL(value);
    const allowed = [...source.allowedHosts, ...(syndication ? source.syndicationHosts || [] : [])];
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.includes(url.hostname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|partner$|click_id$|fbclid$|gclid$|sCh$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

export function articleKey(url, source) {
  const sharedId = source.deduplicationGroup && /(?:Article|article)-([\da-f]+)\.htm/i.exec(new URL(url).pathname)?.[1];
  return sharedId ? `${source.deduplicationGroup}:${sharedId.toLowerCase()}` : url.replace('://www.', '://');
}

export function validDate(value, now = Date.now()) {
  const date = Date.parse(text(value));
  return Number.isFinite(date) && date <= now + 600_000 && date >= now - 72 * 3_600_000 ? new Date(date).toISOString() : null;
}

export function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('invalid_xml');
  return parser.parse(xml);
}

export function parseFeed(xml, source, feed, now = Date.now()) {
  const document = parseXml(xml);
  const items = document.rss?.channel?.item || document.feed?.entry;
  if (!document.rss && !document.feed) throw new Error('not_a_feed');
  return array(items).flatMap((item) => {
    const atomLink = array(item.link).find((link) => !link?.['@_rel'] || link['@_rel'] === 'alternate');
    const url = canonicalUrl(text(item.link) || atomLink?.['@_href'], source);
    const originalHeadline = plainText(item.title, 300);
    const publishedAt = validDate(item.pubDate || item.published || item.updated || item['dc:date'], now);
    if (!url || !originalHeadline || !publishedAt) return [];
    const categories = array(item.category).map((cat) => plainText(text(cat) || cat?.['@_term'], 80)).filter(Boolean);
    return [{ id: articleKey(url, source), url, sourceId: source.id, sourceName: source.name, originalHeadline,
      headline: originalHeadline, description: plainText(item.description || item.summary, 400),
      categories: categories.length ? [...new Set(categories)] : feed.category ? [feed.category] : [],
      publishedAt, rewriteStatus: 'original' }];
  });
}

export function parseNewsSitemap(xml, source, now = Date.now()) {
  const document = parseXml(xml);
  if (!document.urlset) throw new Error('not_a_news_sitemap');
  return array(document.urlset.url).flatMap((entry) => {
    const url = canonicalUrl(text(entry.loc), source);
    const news = entry['news:news'];
    const headline = plainText(news?.['news:title'], 300);
    const publishedAt = validDate(news?.['news:publication_date'], now);
    return url && headline && publishedAt ? [{ url, headline, publishedAt }] : [];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// Every category gets a turn; every publisher gets a turn within that category.
// Chronology breaks ties. Sentiment, engagement, and alarming words never affect rank.
export function coverageOrder(articles) {
  const sorted = [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
  const categories = new Map();
  for (const article of sorted) {
    const category = article.categories[0] || '';
    if (!categories.has(category)) categories.set(category, new Map());
    const sources = categories.get(category);
    if (!sources.has(article.sourceId)) sources.set(article.sourceId, []);
    sources.get(article.sourceId).push(article);
  }
  const groups = [...categories.values()].map((sources) => {
    const queues = [...sources.values()];
    const group = [];
    while (queues.some((queue) => queue.length)) for (const queue of queues) if (queue.length) group.push(queue.shift());
    return group;
  });
  const result = [];
  while (groups.some((group) => group.length)) for (const group of groups) if (group.length) result.push(group.shift());
  return result;
}

export function mergeArticles(previous, incoming, now = Date.now()) {
  const articles = new Map();
  for (const article of [...previous, ...incoming]) {
    if (!validDate(article.publishedAt, now)) continue;
    const existing = articles.get(article.id);
    const sameContent = existing?.originalHeadline === article.originalHeadline && existing?.description === article.description;
    articles.set(article.id, sameContent ? { ...article, headline: existing.headline, rewriteStatus: existing.rewriteStatus,
      rewriteFingerprint: existing.rewriteFingerprint, rewriteSource: existing.rewriteSource } : article);
  }
  return coverageOrder([...articles.values()]).slice(0, 480);
}

export function validateWebsites(config) {
  if (config.version !== 1 || !Array.isArray(config.websites)) throw new Error('Invalid websites.json');
  const ids = new Set();
  for (const source of config.websites) {
    if (!source.id || ids.has(source.id) || !source.name || !source.domain || !Array.isArray(source.allowedHosts) || !source.allowedHosts.length) throw new Error('Invalid or duplicate website');
    ids.add(source.id);
    for (const feed of source.feeds || []) if (!canonicalUrl(feed.url, source, true) || !feed.category) throw new Error(`Invalid feed for ${source.id}`);
    if (source.newsSitemap && !canonicalUrl(source.newsSitemap, source)) throw new Error(`Invalid sitemap for ${source.id}`);
  }
  return config.websites.filter((source) => source.enabled);
}
