import configuration from '../websites.json';
import { coverageOrder, mergeArticles, validateWebsites } from './news.js';
import { ingestSource } from './ingest.js';
import { DEFAULT_REWRITE_MODEL, rewriteBatch } from './rewrite.js';

const sources = validateWebsites(configuration);
const HOUR = 3_600_000;
const json = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export class NewsStore {
  constructor(state, env) {
    this.state = state; this.env = env; this.refreshing = null;
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS edition (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
  }

  readSnapshot() {
    const row = this.state.storage.sql.exec('SELECT payload FROM edition WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.payload) : this.emptySnapshot();
  }

  writeSnapshot(snapshot) {
    this.state.storage.sql.exec('INSERT INTO edition (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(snapshot));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/refresh' && request.method === 'POST') {
      return json(await this.refresh());
    }
    if (request.method !== 'GET' || path !== '/snapshot') return json({ error: 'not_found' }, 404);
    const snapshot = this.readSnapshot();
    if (!snapshot.lastAttemptAt || Date.now() - Date.parse(snapshot.lastAttemptAt) >= HOUR) {
      this.state.waitUntil(this.refresh());
    }
    return json(snapshot);
  }

  emptySnapshot() {
    return { articles: [], updatedAt: null, lastAttemptAt: null, rewriteStatus: 'not_configured', sources: sources.map(({ id, name, domain }) => ({ id, name, domain, state: 'pending', errors: [] })) };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.performRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async performRefresh() {
    const previous = this.readSnapshot();
    const now = Date.now();
    if (previous.lastAttemptAt && now - Date.parse(previous.lastAttemptAt) < HOUR - 30_000) return { state: 'cooldown' };
    // Persist the attempt before network work so failed refreshes cannot create request storms.
    const snapshot = { ...previous, lastAttemptAt: new Date(now).toISOString() };
    this.writeSnapshot(snapshot);
    const incoming = [], statuses = [];
    for (const source of sources) {
      const result = await ingestSource(source, previous.articles, now);
      incoming.push(...result.articles);
      const lastGood = previous.sources.find((status) => status.id === source.id)?.lastSuccessAt;
      statuses.push({ ...result.status, lastSuccessAt: result.status.received ? snapshot.lastAttemptAt : lastGood || null });
    }
    snapshot.articles = mergeArticles(previous.articles, incoming, now);
    const fingerprint = `${this.env.REWRITE_MODEL || DEFAULT_REWRITE_MODEL}:editorial-v2`;
    const configuredLimit = Number(this.env.REWRITES_PER_REFRESH ?? 8);
    const limit = Number.isFinite(configuredLimit) ? Math.max(0, Math.min(8, Math.floor(configuredLimit))) : 8;
    const pending = coverageOrder(snapshot.articles.filter((article) => article.rewriteStatus !== 'rewritten' || article.rewriteFingerprint !== fingerprint)).slice(0, limit);
    snapshot.rewriteStatus = this.env.AI ? 'ok' : 'not_configured';
    for (let index = 0; this.env.AI && index < pending.length; index += 8) {
      const batch = pending.slice(index, index + 8);
      try {
        const { results, status } = await rewriteBatch(batch, this.env);
        if (status !== 'ok') snapshot.rewriteStatus = status;
        for (const article of batch) {
          const headline = results.get(article.id);
          if (headline) { article.headline = headline; article.rewriteStatus = 'rewritten'; article.rewriteFingerprint = fingerprint; }
        }
        if (status === 'provider_unavailable' || status === 'budget_guard') break;
      } catch { snapshot.rewriteStatus = 'provider_unavailable'; break; }
    }
    snapshot.sources = statuses;
    if (incoming.length) snapshot.updatedAt = snapshot.lastAttemptAt;
    this.writeSnapshot(snapshot);
    return { state: 'complete', articles: snapshot.articles.length, rewriteStatus: snapshot.rewriteStatus,
      sources: statuses.map(({ id, state }) => ({ id, state })) };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405);
    if (!['/api/news', '/api/status'].includes(url.pathname)) return json({ error: 'not_found' }, 404);
    try {
      const response = await env.NEWS.getByName('edition').fetch('https://news.internal/snapshot');
      const snapshot = await response.json();
      const publicStatus = { updatedAt: snapshot.updatedAt, lastAttemptAt: snapshot.lastAttemptAt,
        rewriteStatus: snapshot.rewriteStatus, sources: snapshot.sources,
        stale: !snapshot.updatedAt || Date.now() - Date.parse(snapshot.updatedAt) > 2 * HOUR };
      if (url.pathname === '/api/status') return json(publicStatus);
      const query = (url.searchParams.get('q') || '').trim().slice(0, 120).toLocaleLowerCase('he');
      const category = url.searchParams.get('category'), source = url.searchParams.get('source');
      let articles = snapshot.articles.filter((article) => (!category || article.categories.includes(category))
        && (!source || article.sourceId === source)
        && (!query || `${article.headline} ${article.originalHeadline} ${article.description}`.toLocaleLowerCase('he').includes(query)));
      articles = url.searchParams.get('order') === 'latest' ? [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) : coverageOrder(articles);
      const requestedLimit = Number(url.searchParams.get('limit') || 60);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(120, Math.floor(requestedLimit))) : 60;
      const offset = Math.max(0, Math.min(480, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
      return json({ ...publicStatus, categories: [...new Set(snapshot.articles.flatMap((article) => article.categories))].sort((a, b) => a.localeCompare(b, 'he')),
        total: articles.length, articles: articles.slice(offset, offset + limit).map(({ description, rewriteFingerprint, ...article }) => article) });
    } catch { return json({ error: 'temporarily_unavailable' }, 503); }
  },
  async scheduled(controller, env, context) {
    context.waitUntil(env.NEWS.getByName('edition').fetch('https://news.internal/refresh', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error('Refresh failed');
      console.log(JSON.stringify(await response.json()));
    }));
  }
};
