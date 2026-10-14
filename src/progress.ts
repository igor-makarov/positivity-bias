import { meaningfulRewrite } from './headline-change.ts';
import type { Article, Fetch } from './types.ts';
import { coverageOrder } from './news.ts';
import { needsRewrite, sourceFingerprint } from './policy.ts';

const DAY = 24 * 60 * 60 * 1000;

function currentAttempt(article: Article, fingerprint: string) {
  return article.rewriteAttemptPolicy === fingerprint && article.rewriteAttemptSource === sourceFingerprint(article);
}

// Untouched articles go first. An inaccessible page waits a day before another
// fetch, so fresh headlines and the retained backlog can both make progress.
export function pendingArticles<T extends Article>(articles: T[], fingerprint: string, now: number, limit: number, attemptedBefore = Infinity) {
  return coverageOrder(articles.filter((article) => needsRewrite(article, fingerprint)
    && !(currentAttempt(article, fingerprint) && Date.parse(article.rewriteAttemptAt || "") >= attemptedBefore)
    && !(currentAttempt(article, fingerprint) && article.contextState === 'missing'
      && now - Date.parse(article.rewriteAttemptAt || "") < DAY)))
    .sort((a, b) => Number(Date.parse(b.firstSeenAt || '') >= attemptedBefore)
      - Number(Date.parse(a.firstSeenAt || '') >= attemptedBefore)
      || Number(Date.parse(b.firstSeenAt || '') >= now - DAY)
      - Number(Date.parse(a.firstSeenAt || '') >= now - DAY)
      || (currentAttempt(a, fingerprint) ? Date.parse(a.rewriteAttemptAt || "") || 0 : 0)
      - (currentAttempt(b, fingerprint) ? Date.parse(b.rewriteAttemptAt || "") || 0 : 0))
    .slice(0, limit);
}

// Reserve external-request headroom below Workers Free's 50/request ceiling.
// Redirect hops pass through the same counter. This is shared by feed/body fetches.
export function boundedPublisherFetch(fetcher: Fetch, limit = 48) {
  let used = 0, reservedModels = 0;
  const bounded = (...args: Parameters<Fetch>) => {
    if (used >= limit - reservedModels) throw new Error('subrequest_budget');
    used++;
    return fetcher(...args);
  };
  bounded.remaining = () => limit - used - reservedModels;
  bounded.reserveModels = (count: number) => {
    if (count < 0 || count > bounded.remaining()) throw new Error('subrequest_budget');
    reservedModels += count;
  };
  bounded.modelCall = <T>(run: () => T): T => {
    if (reservedModels < 1 || used >= limit) throw new Error('subrequest_budget');
    reservedModels--; used++;
    return run();
  };
  return bounded;
}

// Keep full HTML bodies and outgoing connections bounded while preserving order.
export async function mapConcurrently<T, R>(items: T[], mapper: (item: T, index: number) => Promise<R>, width = 4) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export function rewriteCoverage(articles: Article[], fingerprint: string) {
  const total = articles.length;
  const rewritten = articles.filter((article) => article.rewriteStatus === 'rewritten'
    && article.rewriteFingerprint === fingerprint && meaningfulRewrite(article.originalHeadline, article.headline)).length;
  const sourceUnavailable = articles.filter((article) => currentAttempt(article, fingerprint) && article.contextState === 'missing').length;
  const rejected = articles.filter((article) => article.rewriteStatus === 'rejected' && !needsRewrite(article, fingerprint)).length;
  return { total, rewritten, original: total - rewritten,
    convertedPercent: total ? Math.round(rewritten / total * 1000) / 10 : 0,
    sourceUnavailable, rejected, pending: total - rewritten - sourceUnavailable - rejected };
}

// Prospective conversion coverage, never a claim of factual accuracy. Missing text,
// rejections and deferred titles stay in the denominator. Unchanged copies do not count.
export function newArticles<T extends Article>(articles: T[], since: string, now = Date.now()): T[] {
  const start = Date.parse(since);
  const windowStart = Math.max(Number.isFinite(start) ? start : now, now - DAY);
  return articles.filter((article) => Date.parse(article.firstSeenAt || '') >= windowStart);
}
export function newTitleCoverage(articles: Article[], fingerprint: string, since: string, now = Date.now()) {
  const start = Date.parse(since);
  const windowStart = Math.max(Number.isFinite(start) ? start : now, now - DAY);
  const retained = newArticles(articles, since, now);
  const coverage = rewriteCoverage(retained, fingerprint);
  return { ...coverage, targetPercent: 90, targetMet: coverage.total > 0 && coverage.convertedPercent >= 90,
    since: new Date(windowStart).toISOString(), population: 'retained_new_or_corrected_titles_last_24h' };
}
