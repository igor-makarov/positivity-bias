import configuration from '../websites.json';
import { coverageOrder, mergeArticles, validateWebsites } from './news.js';
import { ingestSource, loadArticleContext } from './ingest.js';
import { DEFAULT_CONTEXT_CHARS } from './extract.js';
import { DEFAULT_REWRITE_MODEL, DEFAULT_VALIDATOR_MODEL, REWRITE_CONTRACT_VERSION, policyFingerprint, retireStaleRewrites, sourceFingerprint } from './policy.js';
import { rewriteBatch, verifyBatch } from './rewrite.js';
import { budgetDecision, dailyNeuronBudget, estimateBatchNeurons, fitBatchToBudget, planBatches, requestContextTokens, SHARED_RESERVED_TOKENS_PER_ITEM } from './budget.js';
import { HOUR, refreshDue } from './refresh.js';
import { boundedPublisherFetch, mapConcurrently, pendingArticles, rewriteCoverage } from './progress.js';

const sources = validateWebsites(configuration);
// A changed policy gets one immediate refresh. Persist
// the policy before work, so repeated readers cannot bypass the hourly guard.
const policyRecoveryDue = (snapshot, env) => snapshot.lastRefreshPolicy !== policyFingerprint(env);

const json = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const contextChars = (env) => {
  const value = Number(env.CONTEXT_CHARS);
  return Number.isFinite(value) && value >= 800 ? Math.min(20_000, Math.floor(value)) : DEFAULT_CONTEXT_CHARS;
};
const maxContextFetches = (env) => {
  const value = Number(env.MAX_CONTEXT_FETCHES);
  return Number.isFinite(value) ? Math.max(0, Math.min(40, Math.floor(value))) : 40;
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
    if (refreshDue(snapshot.lastAttemptAt) || policyRecoveryDue(snapshot, this.env)) {
      this.state.waitUntil(this.refresh());
    }
    return json({ ...snapshot, refreshing: Boolean(this.refreshing || snapshot.rewriteContinuation),
      rewriteCoverage: rewriteCoverage(snapshot.articles, policyFingerprint(this.env)),
      dailyNeurons: { used: Math.round(this.readUsage(this.usageDay())), budget: dailyNeuronBudget(this.env) } });
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
    if (!refreshDue(previous.lastAttemptAt, now) && !policyRecoveryDue(previous, this.env)) return { state: 'cooldown' };
    // Persist the attempt before network work so failed refreshes cannot create request storms.
    const snapshot = { ...previous, lastAttemptAt: new Date(now).toISOString(), lastRefreshPolicy: policyFingerprint(this.env), rewriteDiagnostics: null };
    delete snapshot.rewriteContinuation;
    this.writeSnapshot(snapshot);
    const publisherFetch = boundedPublisherFetch(fetch);
    const incoming = [], statuses = [];
    for (const source of sources) {
      const result = await ingestSource(source, previous.articles, now, publisherFetch);
      incoming.push(...result.articles);
      const lastGood = previous.sources.find((status) => status.id === source.id)?.lastSuccessAt;
      statuses.push({ ...result.status, lastSuccessAt: result.status.received ? snapshot.lastAttemptAt : lastGood || null });
    }
    snapshot.articles = mergeArticles(previous.articles, incoming, now);
    snapshot.sources = statuses;
    await this.rewritePending(snapshot, now, publisherFetch);
    if (incoming.length) snapshot.updatedAt = snapshot.lastAttemptAt;
    snapshot.rewriteContinuation = { policy: policyFingerprint(this.env), day: this.usageDay(now), roundsLeft: 13 };
    await this.finishRewriteChunk(snapshot, now);
    return { state: 'complete', articles: snapshot.articles.length, rewriteStatus: snapshot.rewriteStatus,
      sources: statuses.map(({ id, state }) => ({ id, state })) };
  }

  async finishRewriteChunk(snapshot, now) {
    const continuation = snapshot.rewriteContinuation;
    const pending = pendingArticles(snapshot.articles, policyFingerprint(this.env), now, 1, Date.parse(snapshot.lastAttemptAt));
    const hasBudget = this.readUsage(this.usageDay(now)) < dailyNeuronBudget(this.env);
    const more = continuation?.roundsLeft > 0 && pending.length && hasBudget && snapshot.rewriteStatus !== 'budget_deferred'
      && !['provider_unavailable', 'validator_misconfigured', 'budget_guard'].includes(snapshot.rewriteStatus);
    if (!more) delete snapshot.rewriteContinuation;
    this.writeSnapshot(snapshot);
    if (more) await this.state.storage.setAlarm(Date.now() + 1_000);
    else await this.state.storage.deleteAlarm();
  }

  // These alarms finish one edition's finite backlog. Each article gets at most one
  // model attempt per edition; no visitor-controlled retries or recurring monitor.
  async alarm() {
    if (this.refreshing) { await this.refreshing; return; }
    this.refreshing = this.continueRewrites().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async continueRewrites() {
    const snapshot = this.readSnapshot();
    const continuation = snapshot.rewriteContinuation;
    const now = Date.now();
    if (!continuation) return { state: 'idle' };
    if (continuation.policy !== policyFingerprint(this.env) || continuation.day !== this.usageDay(now)) {
      delete snapshot.rewriteContinuation; this.writeSnapshot(snapshot); return { state: 'continuation_expired' };
    }
    continuation.roundsLeft--;
    await this.rewritePending(snapshot, now, boundedPublisherFetch(fetch));
    await this.finishRewriteChunk(snapshot, now);
    return { state: 'rewrite_continuation', articles: snapshot.articles.length, rewriteStatus: snapshot.rewriteStatus };
  }

  // Adaptive, token-budgeted rewriting. Each request is sized from the actual
  // full-text input, the model context window, reserved output space and the
  // remaining daily neuron budget. Batches never truncate article context to fit
  // more articles; work is deferred instead when budget or context is insufficient.
  async rewritePending(snapshot, now, publisherFetch = boundedPublisherFetch(fetch)) {
    const diagnostics = snapshot.rewriteDiagnostics ||= {
      contextCandidates: 0, contextUsable: 0, rewriteCalls: 0, validatorBatches: 0,
      answered: 0, proposed: 0, alternatives: 0, choiceAnswered: 0, uncertainChoices: 0, verified: 0, accepted: 0, failureStage: null, finishReason: null,
      outputShape: null, returnedItems: 0, contentChars: 0, reasoningChars: 0, responseChannel: null
    };
    const fingerprint = policyFingerprint(this.env);
    const model = this.env.REWRITE_MODEL || DEFAULT_REWRITE_MODEL;
    const validator = this.env.VALIDATOR_MODEL || DEFAULT_VALIDATOR_MODEL;
    if (!this.env.AI) { snapshot.rewriteStatus = 'not_configured'; return; }
    const chars = contextChars(this.env);
    if (this.readUsage(this.usageDay(now)) >= dailyNeuronBudget(this.env)) { snapshot.rewriteStatus = 'budget_deferred'; return; }
    const pending = pendingArticles(snapshot.articles, fingerprint, now,
      Math.min(maxContextFetches(this.env), publisherFetch.remaining()), Date.parse(snapshot.lastAttemptAt));
    diagnostics.contextCandidates += pending.length;
    if (!pending.length) { snapshot.rewriteStatus = 'ok'; return; }
    // Fetch accessible article text once, bounded, so each request is sized from the
    // actual full-text input instead of a worst-case length. Missing context is not
    // cached and keeps the original headline.
    const prepared = await mapConcurrently(pending, async (article) => {
      const source = sources.find((entry) => entry.id === article.sourceId);
      if (!source) return { article, context: { text: '', charCount: 0, completeness: 'missing' }, error: 'unknown_source' };
      return { article, ...(await loadArticleContext(article, source, publisherFetch, { maxChars: chars })) };
    });
    for (const { article, context, error } of prepared) {
      article.rewriteAttemptAt = new Date(now).toISOString();
      article.rewriteAttemptPolicy = fingerprint;
      article.rewriteAttemptSource = sourceFingerprint(article);
      article.contextState = error === 'subrequest_budget' ? 'deferred'
        : context.text && context.completeness !== 'missing' ? 'available' : 'missing';
    }
    const usable = prepared.filter((entry) => entry.context.text && entry.context.completeness !== 'missing');
    diagnostics.contextUsable += usable.length;
    if (!usable.length) { snapshot.rewriteStatus = 'context_unavailable'; return; }
    // The same context goes to the rewrite model and the validator, so a request may
    // only be as large as the smaller of their context windows.
    const contextLimit = requestContextTokens([model, validator]);
    // The shared rewrite+verify request reserves a complete short rewrite result plus
    // the choice question and alternatives evaluated per article by the validator.
    const batches = planBatches(usable.map(({ article, context }) =>
      ({ article, context: context.text, contextLength: context.text.length, completeness: context.completeness })),
      { model, contextTokens: contextLimit, outputTokensPerItem: SHARED_RESERVED_TOKENS_PER_ITEM });
    if (!batches.length) { snapshot.rewriteStatus = 'context_unavailable'; return; }
    const day = this.usageDay(now);
    const budget = dailyNeuronBudget(this.env);
    const models = { rewrite: model, validator };
    let accepted = 0, deferred = false, providerFailed = false, invalidResponse = false;
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
      diagnostics.rewriteCalls++;
      diagnostics.answered += rewrite.evaluated?.size ?? 0;
      diagnostics.proposed += rewrite.candidates.length;
      diagnostics.alternatives += rewrite.candidates.reduce((count, candidate) => count + candidate.headlines.length, 0);
      diagnostics.returnedItems += rewrite.returnedItems ?? 0;
      if (rewrite.outputShape) diagnostics.outputShape = rewrite.outputShape;
      diagnostics.contentChars += rewrite.envelope?.contentChars ?? 0;
      diagnostics.reasoningChars += rewrite.envelope?.reasoningChars ?? 0;
      if (rewrite.envelope?.responseChannel) diagnostics.responseChannel = rewrite.envelope.responseChannel;
      if (rewrite.finishReason) diagnostics.finishReason = rewrite.finishReason;
      if (rewrite.status === 'invalid_response' || (rewrite.evaluated?.size ?? 0) === 0) diagnostics.failureStage = 'rewrite';
      if (rewrite.status === 'invalid_response') invalidResponse = true;
      // A parseable response that answered none of the requested articles is a failed
      // rewrite, not a healthy one: surface it instead of reporting `ok`.
      if (rewrite.status === 'rejected' && (rewrite.evaluated?.size ?? 0) === 0) invalidResponse = true;
      if (rewrite.status === 'provider_unavailable' || rewrite.status === 'budget_guard') {
        this.reconcileUsage(day, estimate, rewrite.usage ?? 0);
        snapshot.rewriteStatus = rewrite.status;
        providerFailed = true;
        break;
      }
      const verified = rewrite.candidates.length
        ? await verifyBatch(rewrite.candidates, this.env, { model: validator })
        : { accepted: new Map(), rejected: new Set(), evaluated: new Set(), usage: null, status: 'rejected' };
      if (rewrite.candidates.length) diagnostics.validatorBatches++;
      diagnostics.verified += verified.evaluated?.size ?? 0;
      diagnostics.choiceAnswered += verified.answered?.size ?? 0;
      diagnostics.uncertainChoices += (verified.answered?.size ?? 0) - (verified.evaluated?.size ?? 0);
      if (verified.answerShape) diagnostics.choiceAnswerShape = verified.answerShape;
      diagnostics.accepted += verified.accepted.size;
      if (rewrite.candidates.length && (verified.answered?.size ?? 0) === 0) diagnostics.failureStage = 'verification';
      // Unknown usage keeps its reservation; never treat absent provider usage as zero.
      const spent = rewrite.usage == null || (rewrite.candidates.length && verified.usage == null)
        ? estimate : rewrite.usage + (verified.usage ?? 0);
      this.reconcileUsage(day, estimate, spent);
      // A clef response that decided NONE of the submitted candidates is a failed
      // verification, not a healthy refresh: report it honestly (and keep originals)
      // instead of a misleading `ok` that would hide a non-functioning validator. A
      // partial answer or a legitimate rejection of every candidate is not affected.
      if (rewrite.candidates.length && (verified.answered?.size ?? 0) === 0) invalidResponse = true;
      for (const [id, headline] of verified.accepted) {
        const article = snapshot.articles.find((entry) => entry.id === id);
        if (article) { article.headline = headline; article.rewriteStatus = 'rewritten'; article.rewriteFingerprint = fingerprint; }
        accepted++;
      }
      // Cache the decision for source-grounded rejections so the same articles are not
      // re-fetched and re-inferred every refresh. A rejection is cached only when the
      // pipeline actually decided on the article: the model answered it and the
      // deterministic guard rejected its candidate, or clef returned a definitive no.
      // An article the model omitted, or a candidate whose clef answer was
      // missing/ambiguous, keeps the preserved original and is retried later instead of
      // being cached as a rejection it never received. Provider/parse failures and
      // missing context are likewise not cached.
      if (['ok', 'partial', 'rejected'].includes(rewrite.status) && ['ok', 'partial', 'rejected'].includes(verified.status)) {
        const candidateIds = new Set(rewrite.candidates.map((candidate) => candidate.id));
        for (const { article } of sized) {
          if (verified.accepted.has(article.id)) continue;
          const guardRejected = rewrite.evaluated?.has(article.id) && !candidateIds.has(article.id);
          if (!guardRejected && !verified.rejected?.has(article.id)) continue;
          article.rewriteStatus = 'rejected';
          article.rewriteFingerprint = fingerprint;
          article.rewriteSource = sourceFingerprint(article);
        }
      }
      if (verified.status === 'provider_unavailable' || verified.status === 'validator_misconfigured') { snapshot.rewriteStatus = verified.status; providerFailed = true; break; }
    }
    snapshot.rewriteStatus = providerFailed ? snapshot.rewriteStatus
      : deferred ? 'budget_deferred' : invalidResponse || diagnostics.failureStage ? diagnostics.accepted ? 'partial' : 'invalid_response' : 'ok';
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
        rewriteStatus: rest.rewriteStatus, sources: rest.sources, refreshing: rest.refreshing === true,
        rewriteCoverage: rest.rewriteCoverage,
        stale: !rest.updatedAt || Date.now() - Date.parse(rest.updatedAt) > 2 * HOUR };
      if (url.pathname === '/api/status') return json({ ...publicStatus, rewriteContract: REWRITE_CONTRACT_VERSION,
        lastRefreshContract: rest.lastRefreshPolicy?.split('|').at(-1) ?? null,
        rewriteDiagnostics: rest.rewriteDiagnostics ?? null, dailyNeurons: rest.dailyNeurons });
      const query = (url.searchParams.get('q') || '').trim().slice(0, 120).toLocaleLowerCase('he');
      const category = url.searchParams.get('category'), source = url.searchParams.get('source');
      let selected = articles.filter((article) => (!category || (article.categories || []).includes(category))
        && (!source || article.sourceId === source)
        && (!query || `${article.headline} ${article.originalHeadline} ${article.description}`.toLocaleLowerCase('he').includes(query)));
      selected = url.searchParams.get('order') === 'latest' ? [...selected].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)) : coverageOrder(selected);
      const requestedLimit = Number(url.searchParams.get('limit') || 60);
      const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(120, Math.floor(requestedLimit))) : 60;
      const offset = Math.max(0, Math.min(480, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
      return json({ ...publicStatus, categories: [...new Set(articles.flatMap((article) => article.categories || []))].sort((a, b) => a.localeCompare(b, 'he')),
        total: selected.length, articles: selected.slice(offset, offset + limit).map(({ description, rewriteFingerprint, rewriteSource, rewriteStatus, context, contextCompleteness, verification, rewriteAttemptAt, rewriteAttemptPolicy, rewriteAttemptSource, contextState, ...article }) => ({
          ...article, categories: article.categories || [], rewriteStatus: rewriteStatus === 'rewritten' ? 'rewritten' : 'original' })) });
    } catch { return json({ error: 'temporarily_unavailable' }, 503); }
  },
  async scheduled(controller, env, context) {
    context.waitUntil(env.NEWS.getByName('edition').fetch('https://news.internal/refresh', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error('Refresh failed');
      console.log(JSON.stringify(await response.json()));
    }));
  }
};
