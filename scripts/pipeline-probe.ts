import type { AIInput, Snapshot } from '../src/types.ts';
import type { MockAnswer, ProbeEnv, ProbeInput } from './fixture-types.ts';
// Probe worker used only by scripts/pipeline-check.ts. It injects a deterministic
// mock model into a real NewsStore so the refresh/rewrite/verify/budget orchestration
// runs under workerd without any external inference.
import worker, { NewsStore } from '../src/worker.ts';
import { rewriteItems } from './fixtures.ts';

const validatorDefault = '@cf/cloudflare/clef-flash';
// Qwen3 wraps its answer in a reasoning block that its chat template emits even when
// thinking is disabled. Build the tags at runtime so this probe (and the pipeline check)
// proves the Worker strips that wrapper instead of only assuming a clean JSON answer.
const THINK_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
const THINK_CLOSE = String.fromCharCode(60) + '/think' + String.fromCharCode(62);

function createMockAI(validatorModel: string, rewriteMode?: string, validatorMode?: string) {
  const calls = { rewrite: 0, verify: 0, models: [] as string[] };
  const run = async (model: string, input: AIInput) => {
    if (model === validatorModel) {
      calls.verify++;
      // A validator that answers none of the questions is a failed verification, not a
      // healthy refresh: the rewrite must be surfaced as invalid, not reported as `ok`.
      if (validatorMode === 'empty') return { model: 'clef-flash', answers: {}, usage: { input_tokens: 1000, output_tokens: 0 } };
      // Native Clef choice answers select an alternative or the original fallback.
      const answers: Record<string,MockAnswer> = {};
      input.state!.forEach((item, index) => {
        const choice = /\/2$/.test(item.id) ? 'original' : 'option_1';
        answers[`${index}_headline`] = { type: 'choice', choice, confidence: 1,
          probabilities: Object.fromEntries([...item.alternatives.map(({ id }) => id), 'original'].map((id) => [id, id === choice ? 1 : 0])) };
      });
      for (const [id, question] of Object.entries(input.questions!)) {
        if (question.type === 'noul') answers[id] = { type: 'noul', noul: answers[`${id.split('_')[0]}_headline`].choice === 'original' ? 0 : 1 };
      }
      return { model: 'clef-flash', answers, usage: { input_tokens: 1000, output_tokens: 0 } };
    }
    calls.rewrite++;
    calls.models.push(model);
    // Return the documented envelope for the configured model: Qwen3 answers under
    // `choices[].message.content` (with a thinking channel), the older Llama shape under
    // `response`. This keeps the default-model path honest instead of assuming one shape.
    const envelope = (content: string) => /qwen3/i.test(model)
      ? { choices: [{ finish_reason: 'stop', message: rewriteMode === 'partial'
        ? { content: THINK_OPEN + 'חשיבה על {הטיוטה} ' + THINK_CLOSE + content }
        : { content: '', reasoning_content: content } }], usage: { prompt_tokens: 1200, completion_tokens: 120 } }
      : { response: content };
    // A model that returns unparseable output must be surfaced, not reported as ok.
    if (rewriteMode === 'invalid') return envelope('not json');
    // Parseable JSON that answers none of the requested articles is also a failure.
    if (rewriteMode === 'empty') return envelope(JSON.stringify({ items: [] }));
    const items = rewriteItems(input);
    // Simulate a model that silently drops an article: only the `/1` article is ever
    // answered, so `/2` is a model omission, not a rejection decision.
    if (rewriteMode === 'partial') {
      const answered = items.filter((item) => item.originalHeadline === 'לפי המועצה: 3 תוכניות אושרו');
      return envelope(JSON.stringify({ items: answered.map((item) => ({ id: item.id, usable: true, headlines: ['לפי המועצה אושרו 3 תוכניות', 'לפי המועצה ניתן אישור ל-3 תוכניות', 'אושרו 3 תוכניות לפי המועצה'] })) }));
    }
    return envelope(JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true,
      headlines: item.originalHeadline.includes('האוכלוסייה') ? ['ראשי ערים קראו לשינוי דמוגרפי בישראל', 'ראשי ערים הציעו לשנות את האוכלוסייה בישראל', 'ראשי ערים מבקשים שינוי באוכלוסיית ישראל'] : ['לפי המועצה אושרו 3 תוכניות', 'לפי המועצה ניתן אישור ל-3 תוכניות', 'אושרו 3 תוכניות לפי המועצה'] })) }));
  };
  return { calls, run };
}

export class PipelineStore extends NewsStore {
  declare env: ProbeEnv;
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json<ProbeInput>();
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
