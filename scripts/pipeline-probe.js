// Probe worker used only by scripts/pipeline-check.js. It injects a deterministic
// mock model into a real NewsStore so the refresh/rewrite/verify/budget orchestration
// runs under workerd without any external inference.
import worker, { NewsStore } from '../src/worker.js';

const validatorDefault = '@cf/cloudflare/clef-flash';

function createMockAI(validatorModel, rewriteMode) {
  const calls = { rewrite: 0, verify: 0 };
  const run = async (model, input) => {
    if (model === validatorModel) {
      calls.verify++;
      // clef answers are `noul` probabilities keyed by the candidate index.
      const answers = {};
      input.state.forEach((item, index) => {
        answers[`${index}_supported`] = { type: 'noul', noul: 1 };
        answers[`${index}_preserved`] = { type: 'noul', noul: /\/2$/.test(item.id) ? 0 : 1 };
      });
      return { model: 'clef-flash', answers, usage: { input_tokens: 1000, output_tokens: 0 } };
    }
    calls.rewrite++;
    // A model that returns unparseable output must be surfaced, not reported as ok.
    if (rewriteMode === 'invalid') return { response: 'not json' };
    // Parseable JSON that answers none of the requested articles is also a failure.
    if (rewriteMode === 'empty') return { response: JSON.stringify({ items: [] }) };
    const items = JSON.parse(input.messages[1].content);
    // Simulate a model that silently drops an article: only the `/1` article is ever
    // answered, so `/2` is a model omission, not a rejection decision.
    if (rewriteMode === 'partial') {
      const answered = items.filter((item) => /\/1$/.test(item.id));
      return { response: JSON.stringify({ items: answered.map((item) => ({ id: item.id, usable: true, headline: 'לפי המועצה אושרו 3 תוכניות' })) }) };
    }
    return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true,
      headline: /\/2$/.test(item.id) ? 'ראשי ערים קראו לשינוי דמוגרפי בישראל' : 'לפי המועצה אושרו 3 תוכניות' })) }) };
  };
  return { calls, run };
}

export class PipelineStore extends NewsStore {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json();
      const mock = createMockAI(body.env?.VALIDATOR_MODEL || validatorDefault, body.env?.MOCK_REWRITE);
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
