// Probe worker used only by scripts/pipeline-check.js. It injects a deterministic
// mock model into a real NewsStore so the refresh/rewrite/verify/budget orchestration
// runs under workerd without any external inference.
import worker, { NewsStore } from '../src/worker.js';

const validatorDefault = '@cf/cloudflare/clef-flash';

function createMockAI(validatorModel) {
  const calls = { rewrite: 0, verify: 0 };
  const run = async (model, input) => {
    const items = JSON.parse(input.messages[1].content);
    if (model === validatorModel) {
      calls.verify++;
      return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, supported: true, preserved: !/\/2$/.test(item.id) })) }) };
    }
    calls.rewrite++;
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
      const mock = createMockAI(body.env?.VALIDATOR_MODEL || validatorDefault);
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
