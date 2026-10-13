// Probe worker used only by scripts/batch-check.js. It injects a deterministic mock
// model and records the size of every verification request, so the check can prove a
// shared rewrite/verify batch never exceeds the validator's context window.
import worker, { NewsStore } from '../src/worker.js';
import { rewriteItems } from './fixtures.js';

const VALIDATOR = '@cf/cloudflare/clef-flash';

function createMockAI() {
  const calls = { rewrite: 0, verify: 0, maxVerifyChars: 0, maxRewriteChars: 0 };
  const run = async (model, input) => {
    if (model === VALIDATOR) {
      calls.verify++;
      calls.maxVerifyChars = Math.max(calls.maxVerifyChars, JSON.stringify(input).length);
      // Native choice response, preserving explicit option identities.
      const answers = {};
      input.state.forEach((item, index) => {
        answers[`${index}_headline`] = { type: 'choice', choice: 'option_1', confidence: 1,
          probabilities: Object.fromEntries([...item.alternatives.map(({ id }) => id), 'original'].map((id) => [id, id === 'option_1' ? 1 : 0])) };
      });
      return { model: 'clef-flash', answers, usage: { input_tokens: 2000, output_tokens: 0 } };
    }
    calls.rewrite++;
    const items = rewriteItems(input);
    calls.maxRewriteChars = Math.max(calls.maxRewriteChars, JSON.stringify(items).length);
    // A changed headline, so coverage cannot count unchanged echoes as conversions.
    return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true, headlines: [`דיווח מקומי: ${item.originalHeadline}`, `פורסם במקור: ${item.originalHeadline}`, `הפרסום המקומי: ${item.originalHeadline}`] })) }) };
  };
  return { calls, run };
}

export class BatchStore extends NewsStore {
  async finishRewriteChunk(snapshot, now) {
    await super.finishRewriteChunk(snapshot, now);
    if (this.env.MOCK_MANUAL_ALARMS && snapshot.rewriteContinuation) await this.state.storage.setAlarm(Date.now() + 60_000);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/continue' && request.method === 'POST') {
      await this.state.storage.deleteAlarm();
      await this.alarm();
      return Response.json({ calls: this.env.AI.calls });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json();
      const mock = createMockAI();
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
