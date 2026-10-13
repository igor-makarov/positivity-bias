import type { AIInput, Snapshot } from '../src/types.ts';
import type { MockAnswer, ProbeEnv, ProbeInput } from './fixture-types.ts';
// Probe worker used only by scripts/batch-check.ts. It injects a deterministic mock
// model and records the size of every verification request, so the check can prove a
// shared rewrite/verify batch never exceeds the validator's context window.
import worker, { NewsStore } from '../src/worker.ts';
import { rewriteItems } from './fixtures.ts';

const VALIDATOR = '@cf/cloudflare/clef-flash';

function createMockAI(invalidFirst = false) {
  const calls = { rewrite: 0, verify: 0, maxVerifyChars: 0, maxRewriteChars: 0 };
  const run = async (model: string, input: AIInput) => {
    if (model === VALIDATOR) {
      calls.verify++;
      calls.maxVerifyChars = Math.max(calls.maxVerifyChars, JSON.stringify(input).length);
      // Native choice response, preserving explicit option identities.
      const answers: Record<string,MockAnswer> = {};
      input.state!.forEach((item, index) => {
        answers[`${index}_headline`] = { type: 'choice', choice: 'option_1', confidence: 1,
          probabilities: Object.fromEntries([...item.alternatives.map(({ id }) => id), 'original'].map((id) => [id, id === 'option_1' ? 1 : 0])) };
      });
      for (const [id, question] of Object.entries(input.questions!)) {
        if (question.type === 'noul') answers[id] = { type: 'noul', noul: answers[`${id.split('_')[0]}_headline`].choice === 'original' ? 0 : 1 };
      }
      return { model: 'clef-flash', answers, usage: { input_tokens: 2000, output_tokens: 0 } };
    }
    calls.rewrite++;
    if (invalidFirst && calls.rewrite === 1) return { response: 'not json' };
    const items = rewriteItems(input);
    calls.maxRewriteChars = Math.max(calls.maxRewriteChars, JSON.stringify(items).length);
    // A changed headline, so coverage cannot count unchanged echoes as conversions.
    return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true, headlines: [`דיווח מקומי: ${item.originalHeadline}`, `פורסם במקור: ${item.originalHeadline}`, `הפרסום המקומי: ${item.originalHeadline}`] })) }) };
  };
  return { calls, run };
}

export class BatchStore extends NewsStore {
  declare env: ProbeEnv;
  async finishRewriteChunk(snapshot: Snapshot, now: number) {
    await super.finishRewriteChunk(snapshot, now);
    if (this.env.MOCK_MANUAL_ALARMS && snapshot.rewriteContinuation) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/continue' && request.method === 'POST') {
      await this.state.storage.deleteAlarm();
      await this.alarm();
      return Response.json({ calls: this.env.AI?.calls });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json<ProbeInput>();
      const mock = createMockAI(body.env?.MOCK_INVALID_FIRST === true);
      this.env = { ...this.env, ...(body.env || {}), AI: mock };
      if (body.snapshot) this.writeSnapshot(body.snapshot);
      const result = await this.refresh();
      return Response.json({ result, calls: mock.calls });
    }
    if (url.pathname === '/usage') return Response.json({ used: this.readUsage(url.searchParams.get('day') || this.usageDay()) });
    return super.fetch(request);
  }
}

export default worker;
