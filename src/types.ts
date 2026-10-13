/** Stored metadata only. Article bodies remain transient inference inputs. */
export interface Article {
  id: string; url?: string; sourceId: string; sourceName?: string;
  originalHeadline: string; headline: string; publishedAt: string;
  description?: string; categories?: string[]; rewriteStatus: string;
  rewriteFingerprint?: string; rewriteSource?: string;
  rewriteAttemptAt?: string; rewriteAttemptPolicy?: string; rewriteAttemptSource?: string;
  contextState?: string; context?: string; contextCompleteness?: string; verification?: unknown;
  firstSeenAt?: string;
}
export interface Source {
  id: string; name: string; domain: string; allowedHosts: string[]; enabled?: boolean;
  syndicationHosts?: string[]; deduplicationGroup?: string;
  feeds?: { url: string; category?: string }[]; newsSitemap?: string;
}
export interface SourceStatus {
  id: string; name: string; domain: string; state: string; checkedAt?: string;
  lastSuccessAt?: string | null; errors: { feed: string; code: string }[]; received?: number;
}
export interface RewriteItem {
  id: string; originalHeadline: string; context?: string; description?: string;
  contextCompleteness?: string; sourceName?: string; publishedAt?: string;
}
export interface Candidate extends RewriteItem { headlines: string[] }
export interface AIInput {
  temperature?: number; max_tokens?: number; response_format?: unknown;
  messages?: { role: string; content: string }[]; raw?: boolean; prompt?: string;
  model?: string; state?: ClefRecord[]; questions?: Record<string, ClefQuestion>;
}
export interface ClefRecord { id: string; source?: string; publishedAt?: string;
  originalHeadline: string; alternatives: { id: string; headline: string }[];
  contextCompleteness?: string; article?: string }
export interface ClefQuestion { type: string; instructions: string; criteria: Record<string,string> }
export interface AI { run(model: string, input: AIInput): Promise<unknown> }
export interface PolicyEnv { REWRITE_MODEL?: string; VALIDATOR_MODEL?: string;
  DAILY_NEURON_BUDGET?: string; CONTEXT_CHARS?: string; MAX_CONTEXT_FETCHES?: string; AI?: AI }
export interface Env extends PolicyEnv {
  NEWS: DurableObjectNamespace; ASSETS: Fetcher;
}
export interface Diagnostics {
  contextCandidates: number; contextUsable: number; rewriteCalls: number; validatorBatches: number;
  answered: number; proposed: number; alternatives: number; choiceAnswered: number;
  uncertainChoices: number; verified: number; accepted: number; returnedItems: number;
  contentChars: number; reasoningChars: number;
  failureStage: string | null; finishReason: string | null; outputShape: string | null; responseChannel: string | null;
  providerFailureReason?: string; choiceAnswerShape?: unknown;
}
export interface Snapshot {
  articles: Article[]; sources: SourceStatus[]; updatedAt: string | null; lastAttemptAt: string | null;
  policyFingerprint: string | null; lastRefreshPolicy?: string; rewriteStatus: string;
  rewritesRetiredAt?: string; rewriteDiagnostics?: Diagnostics | null;
  rewriteContinuation?: { policy: string; day: string; roundsLeft: number };
  newTitlesSince?: string; newTitleCoverage?: unknown; refreshing?: boolean; rewriteCoverage?: Coverage; dailyNeurons?: { used: number; budget: number };
}
export interface RefreshResult { state: string; articles?: number; rewriteStatus?: string;
  sources?: { id: string; state: string }[] }
export type Fetch = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
export interface Context { text: string; charCount: number; completeness: string }
export interface ContextOptions { maxChars?: number; minChars?: number }
export interface Metadata { headline: string; description: string; body: string; categories: string[]; publishedAt?: string }

export interface Coverage { total: number; rewritten: number; original: number; convertedPercent: number; sourceUnavailable: number; rejected: number; pending: number }
