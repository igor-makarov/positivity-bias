// Probe worker used only by scripts/batch-check.js. It injects a deterministic mock
// model and records the size of every verification request, so the check can prove a
// shared rewrite/verify batch never exceeds the validator's context window.
import worker, { NewsStore } from '../src/worker.js';

const VALIDATOR = '@cf/cloudflare/clef-flash';

function createMockAI() {
  const calls = { rewrite: 0, verify: 0, maxVerifyChars: 0, maxRewriteChars: 0 };
  const run = async (model, input) => {
    const items = JSON.parse(input.messages[1].content);
    const chars = input.messages[1].content.length;
    if (model === VALIDATOR) {
      calls.verify++;
      calls.maxVerifyChars = Math.max(calls.maxVerifyChars, chars);
      return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, supported: true, preserved: true })) }) };
    }
    calls.rewrite++;
    calls.maxRewriteChars = Math.max(calls.maxRewriteChars, chars);
    // Echo the original headline: a faithful, dry candidate that the heuristics accept.
    return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true, headline: item.originalHeadline })) }) };
  };
  return { calls, run };
}

export class BatchStore extends NewsStore {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json();
      const mock = createMockAI();
      this.env = { ...this.env, ...(body.env || {}), AI: mock };
      if (body.snapshot) this.writeSnapshot(body.snapshot);
      const result = await this.refresh();
      return Response.json({ result, calls: mock.calls });
    }
    return super.fetch(request);
  }
}

export default worker;
