// Pure text helpers shared by the feed parsers and the article-body extractor.
// Kept free of XML dependencies so the extractor can be bundled and run alone.

export const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
export const text = (value) => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value?.['#text'] || '';

export function plainText(value, limit = 600) {
  return text(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[n.toLowerCase()])
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function articleMetadata(jsonTexts, meta = {}) {
  const nodes = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    nodes.push(value);
    if (value['@graph']) visit(value['@graph']);
    if (value.mainEntity) visit(value.mainEntity);
  }
  for (const value of jsonTexts) { try { visit(JSON.parse(value)); } catch { /* A malformed publisher block does not discard valid ones. */ } }
  const article = nodes.find((node) => array(node['@type']).some((type) => ['NewsArticle', 'Article', 'ReportageNewsArticle'].includes(type))) || {};
  return { headline: plainText(article.headline || meta['og:title'], 300),
    description: plainText(article.description || meta['og:description'] || meta.description, 400),
    body: plainText(article.articleBody, 200_000),
    categories: array(article.articleSection || meta['article:section']).map((cat) => plainText(cat, 80)).filter(Boolean),
    publishedAt: article.datePublished || meta['article:published_time'] };
}
