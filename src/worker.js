import configuration from '../websites.json';
import { coverageOrder, mergeArticles, validateWebsites } from './news.js';
import { ingestSource, loadArticleContext } from './ingest.js';
import { DEFAULT_CONTEXT_CHARS } from './extract.js';
import { DEFAULT_REWRITE_MODEL, DEFAULT_VALIDATOR_MODEL, needsRewrite, policyFingerprint, retireStaleRewrites, sourceFingerprint } from './policy.js';
import { rewriteBatch, verifyBatch } from './rewrite.js';
import { budgetDecision, dailyNeuronBudget, estimateBatchNeurons, fitBatchToBudget, planBatches, requestContextTokens, SHARED_RESERVED_TOKENS_PER_ITEM } from './budget.js';

const sources = validateWebsites(configuration);
const HOUR = 3_600_000;

const json = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const contextChars = (env) => {
  const value = Number(env.CONTEXT_CHARS);
  return Number.isFinite(value) && value >= 800 ? Math.min(20_000, Math.floor(value)) : DEFAULT_CONTEXT_CHARS;
};
const maxContextFetches = (env) => {
  const value = Number(env.MAX_CONTEXT_FETCHES);
  return Number.isFinite(value) ? Math.max(0, Math.min(40, Math.floor(value))) : 20;
};

export class NewsStore {
  constructor(state, env) {
    this.state = state; this.env = env; this.refreshing = null;
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS edition (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, neurons REAL NOT NULL, updatedAt TEXT NOT NULL)');
  }

  // Serve-time enforcement: a cached rewrite is displayed only while its fingerprint
  // matches the active policy. The check runs against the actual article state on every
  // read (not just when the snapshot-level flag changes), so a stale/generated headline
  // can never be served even if the flag was already advanced. The persisted migration is
  // idempotent and runs before the next refresh, cooldown or quota failure.
  applyPolicyRetirement(snapshot) {
    const fingerprint = policyFingerprint(this.env);
    const staleFlag = snapshot.policyFingerprint !== fingerprint;
    const { articles, changed } = retireStaleRewrites(snapshot.articles || [], fingerprint);
    if (!changed && !staleFlag) return snapshot;
    snapshot.articles = articles;
    snapshot.policyFingerprint = fingerprint;
    if (changed) snapshot.rewritesRetiredAt = new Date().toISOString();
    this.writeSnapshot(snapshot);
    return snapshot;
  }

  readSnapshot() {
    const row = this.state.storage.sql.exec('SELECT payload FROM edition WHERE id = 1').toArray()[0];
    return this.applyPolicyRetirement(row ? JSON.parse(row.payload) : this.emptySnapshot());
  }

  writeSnapshot(snapshot) {
    this.state.storage.sql.exec('INSERT INTO edition (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload', JSON.stringify(snapshot));
  }

  usageDay(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

  readUsage(day) {
    const row = this.state.storage.sql.exec('SELECT neurons FROM usage WHERE day = ?', day).toArray()[0];
    return row ? Number(row.neurons) || 0 : 0;
  }

  reserveUsage(day, estimate) {
    const budget = dailyNeuronBudget(this.env);
    const used = this.readUsage(day);
    const decision = budgetDecision(used, estimate, budget);
    if (!decision.allowed) return { ...decision, used };
    this.setUsage(day, used + estimate);
    return { ...decision, used: used + estimate };
  }

  reconcileUsage(day, estimate, actual) {
    if (actual == null) return;
    this.setUsage(day, Math.max(0, this.readUsage(day) - estimate + actual));
  }

  setUsage(day, neurons) {
    this.state.storage.sql.exec('INSERT INTO usage (day, neurons, updatedAt) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET neurons = excluded.neurons, updatedAt = excluded.updatedAt',
      day, neurons, new Date().toISOString());
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/refresh' && request.method === 'POST') return json(await this.refresh());
    if (request.method !== 'GET' || path !== '/snapshot') return json({ error: 'not_found' }, 404);
    const snapshot = this.readSnapshot();
    if (!snapshot.lastAttemptAt || Date.now() - Date.parse(snapshot.lastAttemptAt) >= HOUR) {
      this.state.waitUntil(this.refresh());
    }
    return json(snapshot);
  }

  emptySnapshot() {
    return { articles: [], updatedAt: null, lastAttemptAt: null, policyFingerprint: null,
      rewriteStatus: 'not_configured', sources: sources.map(({ id, name, domain }) => ({ id, name, domain, state: 'pending', errors: [] })) };
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
    snapshot.sources = statuses;
    await this.rewritePending(snapshot, now);
    if (incoming.length) snapshot.updatedAt = snapshot.lastAttemptAt;
    this.writeSnapshot(snapshot);
    return { state: 'complete', articles: snapshot.articles.length, rewriteStatus: snapshot.rewriteStatus,
      sources: statuses.map(({ id, state }) => ({ id, state })) };
  }

  // Adaptive, token-budgeted rewriting. Each request is sized from the actual
  // full-text input, the model context window, reserved output space and the
  // remaining daily neuron budget. Batches never truncate article context to fit
  // more articles; work is deferred instead when budget or context is insufficient.
  async rewritePending(snapshot, now) {
    const fingerprint = policyFingerprint(this.env);
    const model = this.env.REWRITE_MODEL || DEFAULT_REWRITE_MODEL;
    const validator = this.env.VALIDATOR_MODEL || DEFAULT_VALIDATOR_MODEL;
    if (!this.env.AI) { snapshot.rewriteStatus = 'not_configured'; return; }
    const chars = contextChars(this.env);
    const pending = coverageOrder(snapshot.articles.filter((article) => needsRewrite(article, fingerprint)))
      .slice(0, maxContextFetches(this.env));
    if (!pending.length) { snapshot.rewriteStatus = 'ok'; return; }
    // Fetch accessible article text once, bounded, so each request is sized from the
    // actual full-text input instead of a worst-case length. Missing context is not
    // cached and keeps the original headline.
    const prepared = await Promise.all(pending.map(async (article) => {
      const source = sources.find((entry) => entry.id === article.sourceId);
      if (!source) return { article, context: { text: '', charCount: 0, completeness: 'missing' }, error: 'unknown_source' };
      return { article, ...(await loadArticleContext(article, source, fetch, { maxChars: chars })) };
    }));
    const usable = prepared.filter((entry) => entry.context.text && entry.context.completeness !== 'missing');
    if (!usable.length) { snapshot.rewriteStatus = 'context_unavailable'; return; }
    // The same context goes to the rewrite model and the validator, so a request may
    // only be as large as the smaller of their context windows.
    const contextLimit = requestContextTokens([model, validator]);
    // The shared rewrite+verify request reserves a complete short rewrite result plus
    // the two factual/preservation questions asked per candidate by the validator.
    const batches = planBatches(usable.map(({ article, context }) =>
      ({ article, context: context.text, contextLength: context.text.length, completeness: context.completeness })),
      { model, contextTokens: contextLimit, outputTokensPerItem: SHARED_RESERVED_TOKENS_PER_ITEM });
    if (!batches.length) { snapshot.rewriteStatus = 'context_unavailable'; return; }
    const day = this.usageDay(now);
    const budget = dailyNeuronBudget(this.env);
    const models = { rewrite: model, validator };
    let accepted = 0, deferred = false, providerFailed = false;
    for (const batch of batches) {
      // Size this request by the remaining daily budget as well as the context window,
      // so a large planned batch is reduced rather than deferring every article when
      // only part of it fits. Context is never truncated to make room.
      const sized = fitBatchToBudget(batch, models, Math.max(0, budget - this.readUsage(day)));
      if (!sized.length) { deferred = true; break; }
      const estimate = estimateBatchNeurons(models, sized);
      const reservation = this.reserveUsage(day, estimate);
      if (!reservation.allowed) { deferred = true; break; }
      const items = sized.map(({ article, context, completeness }) => ({ id: article.id, sourceName: article.sourceName,
        originalHeadline: article.originalHeadline, publishedAt: article.publishedAt,
        context, contextCompleteness: completeness }));
      const rewrite = await rewriteBatch(items, this.env, { model });
      if (rewrite.status === 'provider_unavailable' || rewrite.status === 'budget_guard') {
        this.reconcileUsage(day, estimate, rewrite.usage ?? 0);
        snapshot.rewriteStatus = rewrite.status;
        providerFailed = true;
        break;
      }
      let spent = rewrite.usage ?? null;
      const verified = rewrite.candidates.length
        ? await verifyBatch(rewrite.candidates, this.env, { model: validator })
        : { accepted: new Map(), usage: null, status: 'rejected' };
      if (verified.usage != null) spent = (spent ?? 0) + verified.usage;
      this.reconcileUsage(day, estimate, spent ?? estimate);
      for (const [id, headline] of verified.accepted) {
        const article = snapshot.articles.find((entry) => entry.id === id);
        if (article) { article.headline = headline; article.rewriteStatus = 'rewritten'; article.rewriteFingerprint = fingerprint; }
        accepted++;
      }
      // Cache the validation decision for source-grounded rejections so the same
      // articles are not re-fetched and re-inferred every refresh. Provider/parse
      // failures and missing context are not cached and may be retried.
      if (['ok', 'partial', 'rejected'].includes(rewrite.status) && ['ok', 'partial', 'rejected'].includes(verified.status)) {
        for (const { article } of sized) {
          if (verified.accepted.has(article.id)) continue;
          article.rewriteStatus = 'rejected';
          article.rewriteFingerprint = fingerprint;
          article.rewriteSource = sourceFingerprint(article);
        }
      }
      if (verified.status === 'provider_unavailable' || verified.status === 'validator_misconfigured') { snapshot.rewriteStatus = verified.status; providerFailed = true; break; }
    }
    snapshot.rewriteStatus = providerFailed ? snapshot.rewriteStatus
      : accepted ? 'ok' : deferred ? 'budget_deferred' : 'ok';
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
      const { articles = [], ...rest } = snapshot;
      const publicStatus = { updatedAt: rest.updatedAt, lastAttemptAt: rest.lastAttemptAt,
        rewriteStatus: rest.rewriteStatus, sources: rest.sources,
        stale: !rest.updatedAt || Date.now() - Date.parse(rest.updatedAt) > 2 * HOUR };
      if (url.pathname === '/api/status') return json(publicStatus);
      const query = (url.searchParams.get('q') || '').trim().slice(0, 120).toLocaleLowerCase('he');
      const category = url.searchParams.get('category'), source = url.searchParams.get('source');
      let selected = articles.filter((article) => (!category || article.categories.includes(category))
        && (!source || article.sourceId === source)
        && (!query || `${article.headline} ${article.originalHeadline} ${article.description}`.toLocaleLowerCase('he').includes(query)));
      selected = url.searchParams.get('order') === 'latest' ? [...selected].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) : coverageOrder(selected);
      const requestedLimit = Number(url.searchParams.get('limit') || 60);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(120, Math.floor(requestedLimit))) : 60;
      const offset = Math.max(0, Math.min(480, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
      return json({ ...publicStatus, categories: [...new Set(articles.flatMap((article) => article.categories))].sort((a, b) => a.localeCompare(b, 'he')),
        total: selected.length, articles: selected.slice(offset, offset + limit).map(({ description, rewriteFingerprint, rewriteSource, rewriteStatus, context, contextCompleteness, verification, ...article }) => ({
          ...article, rewriteStatus: rewriteStatus === 'rewritten' ? 'rewritten' : 'original' })) });
    } catch { return json({ error: 'temporarily_unavailable' }, 503); }
  },
  async scheduled(controller, env, context) {
    context.waitUntil(env.NEWS.getByName('edition').fetch('https://news.internal/refresh', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error('Refresh failed');
      console.log(JSON.stringify(await response.json()));
    }));
  }
};
