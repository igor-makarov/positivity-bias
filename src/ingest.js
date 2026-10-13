import { articleKey, canonicalUrl, coverageOrder, parseFeed, parseNewsSitemap, validDate } from './news.js';
import { prepareContext, readArticleData } from './extract.js';

export async function fetchPublisher(url, source, fetcher = fetch) {
  let target = canonicalUrl(url, source, true);
  if (!target) throw new Error('unapproved_url');
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'PositivityBias/0.1 (+https://github.com/igor-makarov/positivity-bias)', Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8' } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      target = next ? canonicalUrl(new URL(next, target).href, source, true) : null;
      if (!target) throw new Error('unapproved_redirect');
      continue;
    }
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty_response');
    const decoder = new TextDecoder();
    let body = '', bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) throw new Error('response_too_large');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    return { body, url: target };
  }
  throw new Error('too_many_redirects');
}

// Full accessible article text for inference context only. The extracted body is
// returned transiently and is never persisted on the article or exposed by the API.
export async function loadArticleContext(article, source, fetcher = fetch, contextOptions) {
  try {
    const { body: html } = await fetchPublisher(article.url, source, fetcher);
    const data = await readArticleData(html);
    return { context: prepareContext(data.body, contextOptions), bodyChars: (data.body || '').length, headline: data.headline };
  } catch (error) {
    return { context: { text: '', charCount: 0, completeness: 'missing' }, error: safeError(error) };
  }
}

export async function readMetadata(html) {
  return readArticleData(html);
}

export async function ingestSource(source, previous, now = Date.now(), fetcher = fetch, metadataReader = readArticleData) {
  const articles = [], errors = [];
  let succeeded = 0;
  for (const feed of source.feeds || []) {
    try {
      const { body } = await fetchPublisher(feed.url, source, fetcher);
      const parsed = parseFeed(body, source, feed, now);
      articles.push(...parsed);
      if (parsed.length) succeeded++;
      else errors.push({ feed: feed.url, code: 'no_recent_articles' });
    } catch (error) { errors.push({ feed: feed.url, code: safeError(error) }); }
  }
  if (source.newsSitemap) {
    try {
      const { body } = await fetchPublisher(source.newsSitemap, source, fetcher);
      const candidates = parseNewsSitemap(body, source, now).slice(0, 8);
      let accepted = 0;
      for (const candidate of candidates) {
        const id = articleKey(candidate.url, source);
        // Re-read publisher metadata for corrections on every refresh, even for known URLs.
        try {
          const { body: html, url } = await fetchPublisher(candidate.url, source, fetcher);
          const data = await metadataReader(html);
          const publishedAt = validDate(data.publishedAt || candidate.publishedAt, now);
          if (!publishedAt) continue;
          const headline = data.headline || candidate.headline;
          articles.push({ id, url, sourceId: source.id, sourceName: source.name,
            originalHeadline: headline, headline, description: data.description, categories: data.categories,
            publishedAt, rewriteStatus: 'original' });
          accepted++;
        } catch (error) { errors.push({ feed: candidate.url, code: safeError(error) }); }
      }
      if (accepted) succeeded++;
      else errors.push({ feed: source.newsSitemap, code: 'no_recent_articles' });
    } catch (error) { errors.push({ feed: source.newsSitemap, code: safeError(error) }); }
  }
  return { articles: coverageOrder(articles).slice(0, 40), status: {
    id: source.id, name: source.name, domain: source.domain, checkedAt: new Date(now).toISOString(),
    state: succeeded ? errors.length ? 'partial' : 'ok' : 'unavailable', errors, received: articles.length
  } };
}

export function safeError(error) {
  return /^(source_http_\d+|unapproved_url|unapproved_redirect|response_too_large|empty_response|too_many_redirects|invalid_xml|not_a_feed|not_a_news_sitemap)$/.test(error?.message)
    ? error.message : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
}
