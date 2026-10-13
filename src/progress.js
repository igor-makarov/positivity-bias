import { coverageOrder } from './news.js';
import { needsRewrite, sourceFingerprint } from './policy.js';

const DAY = 24 * 60 * 60 * 1000;

function currentAttempt(article, fingerprint) {
  return article.rewriteAttemptPolicy === fingerprint && article.rewriteAttemptSource === sourceFingerprint(article);
}

// Untouched articles go first. An inaccessible page waits a day before another
// fetch, so fresh headlines and the retained backlog can both make progress.
export function pendingArticles(articles, fingerprint, now, limit, attemptedBefore = Infinity) {
  return coverageOrder(articles.filter((article) => needsRewrite(article, fingerprint)
    && !(currentAttempt(article, fingerprint) && Date.parse(article.rewriteAttemptAt) >= attemptedBefore)
    && !(currentAttempt(article, fingerprint) && article.contextState === 'missing'
      && now - Date.parse(article.rewriteAttemptAt) < DAY)))
    .sort((a, b) => (currentAttempt(a, fingerprint) ? Date.parse(a.rewriteAttemptAt) || 0 : 0)
      - (currentAttempt(b, fingerprint) ? Date.parse(b.rewriteAttemptAt) || 0 : 0))
    .slice(0, limit);
}

// Reserve external-request headroom below Workers Free's 50/request ceiling.
// Redirect hops pass through the same counter. This is shared by feed/body fetches.
export function boundedPublisherFetch(fetcher, limit = 44) {
  let used = 0;
  const bounded = (...args) => {
    if (used >= limit) throw new Error('subrequest_budget');
    used++;
    return fetcher(...args);
  };
  bounded.remaining = () => limit - used;
  return bounded;
}

export function rewriteCoverage(articles, fingerprint) {
  const total = articles.length;
  const rewritten = articles.filter((article) => article.rewriteStatus === 'rewritten'
    && article.rewriteFingerprint === fingerprint && article.headline !== article.originalHeadline).length;
  const sourceUnavailable = articles.filter((article) => currentAttempt(article, fingerprint) && article.contextState === 'missing').length;
  const rejected = articles.filter((article) => article.rewriteStatus === 'rejected' && !needsRewrite(article, fingerprint)).length;
  return { total, rewritten, original: total - rewritten,
    convertedPercent: total ? Math.round(rewritten / total * 1000) / 10 : 0,
    sourceUnavailable, rejected, pending: total - rewritten - sourceUnavailable - rejected };
}
