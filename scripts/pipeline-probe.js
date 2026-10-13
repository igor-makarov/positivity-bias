// Probe worker used only by scripts/pipeline-check.js. It injects a deterministic
// mock model into a real NewsStore so the refresh/rewrite/verify/budget orchestration
// runs under workerd without any external inference.
import worker, { NewsStore } from '../src/worker.js';

const validatorDefault = '@cf/cloudflare/clef-flash';
// Qwen3 wraps its answer in a reasoning block that its chat template emits even when
// thinking is disabled. Build the tags at runtime so this probe (and the pipeline check)
// proves the Worker strips that wrapper instead of only assuming a clean JSON answer.
const THINK_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
const THINK_CLOSE = String.fromCharCode(60) + '/think' + String.fromCharCode(62);

function createMockAI(validatorModel, rewriteMode, validatorMode) {
  const calls = { rewrite: 0, verify: 0, models: [] };
  const run = async (model, input) => {
    if (model === validatorModel) {
      calls.verify++;
      // A validator that answers none of the questions is a failed verification, not a
      // healthy refresh: the rewrite must be surfaced as invalid, not reported as `ok`.
      if (validatorMode === 'empty') return { model: 'clef-flash', answers: {}, usage: { input_tokens: 1000, output_tokens: 0 } };
      // clef answers are `noul` probabilities keyed by the candidate index.
      const answers = {};
      input.state.forEach((item, index) => {
        answers[`${index}_supported`] = { type: 'noul', noul: 1 };
        answers[`${index}_preserved`] = { type: 'noul', noul: /\/2$/.test(item.id) ? 0 : 1 };
      });
      return { model: 'clef-flash', answers, usage: { input_tokens: 1000, output_tokens: 0 } };
    }
    calls.rewrite++;
    calls.models.push(model);
    // Return the documented envelope for the configured model: Qwen3 answers under
    // `choices[].message.content` (with a thinking channel), the older Llama shape under
    // `response`. This keeps the default-model path honest instead of assuming one shape.
    const envelope = (content) => /qwen3/i.test(model)
      ? { choices: [{ message: { content: THINK_OPEN + 'חשיבה על {הטיוטה} ' + THINK_CLOSE + content, reasoning_content: 'חשיבה' } }], usage: { prompt_tokens: 1200, completion_tokens: 120 } }
      : { response: content };
    // A model that returns unparseable output must be surfaced, not reported as ok.
    if (rewriteMode === 'invalid') return envelope('not json');
    // Parseable JSON that answers none of the requested articles is also a failure.
    if (rewriteMode === 'empty') return envelope(JSON.stringify({ items: [] }));
    const items = JSON.parse(input.messages[1].content);
    // Simulate a model that silently drops an article: only the `/1` article is ever
    // answered, so `/2` is a model omission, not a rejection decision.
    if (rewriteMode === 'partial') {
      const answered = items.filter((item) => item.originalHeadline === 'לפי המועצה: 3 תוכניות אושרו');
      return envelope(JSON.stringify({ items: answered.map((item) => ({ id: item.id, usable: true, headline: 'לפי המועצה אושרו 3 תוכניות' })) }));
    }
    return envelope(JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true,
      headline: item.originalHeadline.includes('האוכלוסייה') ? 'ראשי ערים קראו לשינוי דמוגרפי בישראל' : 'לפי המועצה אושרו 3 תוכניות' })) }));
  };
  return { calls, run };
}

export class PipelineStore extends NewsStore {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json();
      const mock = createMockAI(body.env?.VALIDATOR_MODEL || validatorDefault, body.env?.MOCK_REWRITE, body.env?.MOCK_VALIDATOR);
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
