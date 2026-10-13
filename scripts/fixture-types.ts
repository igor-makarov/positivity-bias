import type { Article, AI, Env, RefreshResult, Snapshot } from '../src/types.ts';
export interface MockAnswer { type: string; choice?: string; confidence?: number;
  probabilities?: Record<string,number>; noul?: number }
export interface MockCalls { rewrite: number; verify: number; models?: string[];
  maxVerifyChars?: number; maxRewriteChars?: number }
export interface ProbeEnv extends Env { MOCK_MANUAL_ALARMS?: boolean; MOCK_INVALID_FIRST?: boolean;
  MOCK_REWRITE?: string; MOCK_VALIDATOR?: string; AI?: AI & { calls?: MockCalls } }
export interface ProbeInput { env?: ProbeEnv; snapshot?: Snapshot }
/** Unified test endpoint projection; assertions below verify each endpoint's contract. */
export interface FixtureResponse extends Snapshot {
  result: RefreshResult; calls: Required<MockCalls>; used: number; total: number;
  categories: string[]; stale: boolean; state: string; body: string; charCount: number;
  completeness: string; headline: string; rewriteContract: string; lastRefreshContract: string;
  articles: (Article & { url: string; categories: string[] })[];
}
