import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRewrite, CLEF_ACCEPT_PROBABILITY, CLEF_MAX_CANDIDATES, DEFAULT_REWRITE_MODEL, EDITORIAL_PROMPT, VERIFICATION_PROMPT, VERIFICATION_QUESTIONS, modelUsageNeurons, parseJsonObject, parseModelText, planVerificationBatches, rewriteBatch, verifyBatch } from '../src/rewrite.js';
import { DEFAULT_VALIDATOR_MODEL } from '../src/policy.js';
import { OUTPUT_TOKENS_PER_ITEM } from '../src/budget.js';

const base = { id: 'story-1', sourceName: 'ynet', publishedAt: '2026-10-13T11:00:00Z',
  originalHeadline: 'לפי המשטרה: 3 בני אדם נפצעו באירוע',
  context: 'המשטרה מסרה כי הנסיבות נבדקות. לפי המשטרה, 3 בני אדם נפצעו באירוע.',
  contextCompleteness: 'complete' };
const result = (headline, extra = {}) => ({ id: 'story-1', headline, usable: true, ...extra });
// Build a clef decision response: two `noul` probabilities per candidate, keyed by the
// candidate index the request used.
const clef = (verdicts) => {
  const probability = (value) => typeof value === 'number' ? value : value ? 1 : 0;
  return { model: 'clef-flash', answers: Object.fromEntries(verdicts.flatMap((verdict, index) => [
    [`${index}_supported`, { type: 'noul', noul: probability(verdict.supported) }],
    [`${index}_preserved`, { type: 'noul', noul: probability(verdict.preserved) }],
  ])) };
};
const clefEnv = (verdicts) => ({ AI: { run: async (model, input) => {
  assert.equal(model, DEFAULT_VALIDATOR_MODEL);
  assert.equal(input.model, 'clef-flash'); // documented selector, not a chat envelope
  assert.ok(Array.isArray(input.state));
  assert.equal(input.messages, undefined);
  assert.equal(input.response_format, undefined);
  assert.equal(input.max_tokens, undefined);
  // Documented question limits: 1..64 questions, ids of [A-Za-z0-9_.-] up to 100 chars.
  const keys = Object.keys(input.questions);
  assert.equal(keys.length, input.state.length * 2);
  assert.ok(keys.length >= 1 && keys.length <= 64);
  assert.ok(keys.every((key) => /^[A-Za-z0-9_.-]{1,100}$/.test(key)));
  assert.ok(keys.every((key) => ['noul', 'choice', 'score'].includes(input.questions[key].type)));
  return clef(verdicts);
} } });

test('Factual dry headlines preserve numbers and attribution against full context', () => {
  assert.equal(acceptRewrite(base, result('לפי המשטרה, 3 בני אדם נפצעו באירוע')), 'לפי המשטרה, 3 בני אדם נפצעו באירוע');
});
test('Changed numbers, dropped attribution, certainty changes and emotional output are rejected', () => {
  for (const headline of ['לפי המשטרה, 5 בני אדם נפצעו', 'לפי המשטרה, אנשים נפצעו', '3 בני אדם נפצעו באירוע', 'לפי המשטרה, 3 בני אדם נפצעו!']) assert.equal(acceptRewrite(base, result(headline)), null);
  const allegation = { ...base, originalHeadline: 'חשד להונאה: 3 בני אדם נעצרו' };
  assert.equal(acceptRewrite(allegation, result('3 בני אדם נעצרו בגין הונאה')), null);
  assert.equal(acceptRewrite(allegation, result('3 בני אדם נעצרו בחשד להונאה')), '3 בני אדם נעצרו בחשד להונאה');
});
test('A rewrite may not introduce rhetorical questions or new sensational framing', () => {
  assert.equal(acceptRewrite(base, result('מה קרה באירוע שבו נפצעו 3 בני אדם?')), null);
  assert.equal(acceptRewrite(base, result('בהלם: לפי המשטרה, 3 בני אדם נפצעו באירוע')), null);
  const alreadySensational = { ...base, originalHeadline: 'מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע' };
  assert.equal(acceptRewrite(alreadySensational, result('מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע')), 'מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע');
});

// Regression 1: the reported success-to-failure reversal. The source headline and
// body both say the drone test succeeded; the rewrite says it failed.
const drone = { id: 'drone-1', sourceName: 'ynet', publishedAt: '2026-10-13T11:00:00Z',
  originalHeadline: 'התעשייה האווירית השלימה בהצלחה ניסוי במל״ט שמצויד במקלע',
  context: 'התעשייה האווירית הודיעה כי השלימה בהצלחה ניסוי במל״ט שמצויד במקלע. הניסוי נחשב להצלחה.',
  contextCompleteness: 'complete' };
const reversed = 'תעשייה אווירית: ניסוי במל״ט עם מקלע נכשל';
test('A success-to-failure reversal is rejected even before verification', () => {
  assert.equal(acceptRewrite(drone, { id: 'drone-1', headline: reversed, usable: true }), null);
});
test('The exact success-to-failure reversal is rejected by verification and keeps the original', async () => {
  const { accepted, status } = await verifyBatch([{ ...drone, headline: reversed }], clefEnv([{ supported: false, preserved: true }]));
  assert.equal(accepted.size, 0);
  assert.equal(status, 'rejected');
});

// Regression 2: a vague publisher headline was replaced by an unsupported abstract
// national demographic claim that dropped the actual speakers (mayors of Karmiel and
// Dimona) and the tourism-versus-permanent-residence point.
const periphery = { id: 'north-1', sourceName: 'mako', publishedAt: '2026-10-13T11:00:00Z',
  originalHeadline: 'האוכלוסייה בישראל רואה את הצפון כצימר לסופ״ש אבל לא כמקום לגור בו',
  context: 'ראש עיריית כרמיאל וראש עיריית דימונה אמרו בכנס כי הצפון נתפס כצימר לסופ״ש ולא כמקום לגור בו. ראשי הערים בפריפריה קראו לחזק את האזורים האלה.',
  contextCompleteness: 'complete' };
const abstractClaim = 'ראשי ערים קראו לשינוי דמוגרפי בישראל';
test('A rewrite that drops the Karmiel/Dimona speakers and the residence point fails verification', async () => {
  const { accepted } = await verifyBatch([{ ...periphery, headline: abstractClaim }], clefEnv([{ supported: true, preserved: false }]));
  assert.equal(accepted.size, 0);
});
test('A faithful rewrite that keeps the speakers and the tourism point is accepted', async () => {
  const faithful = 'ראשי הערים מכרמיאל ומדימונה: הצפון נתפס כצימר לסופ״ש ולא כמקום לגור בו';
  const env = { AI: { run: async (model, input) => {
    assert.equal(model, DEFAULT_VALIDATOR_MODEL);
    assert.match(input.state[0].article, /כרמיאל/); // full article context is sent to the validator
    assert.equal(input.questions['0_supported'].type, 'noul');
    assert.match(input.questions['0_preserved'].instructions, /Preserved/);
    return clef([{ supported: true, preserved: true }]);
  } } };
  const { accepted } = await verifyBatch([{ ...periphery, headline: faithful }], env);
  assert.equal(accepted.get('north-1'), faithful);
});

test('Verification rejects a merely plausible but incomplete or uncertain candidate', async () => {
  for (const verdict of [
    { supported: true, preserved: false },
    { supported: false, preserved: true },
    { supported: true }, // missing preserved answer
    { supported: 0.4, preserved: 0.9 } // below the documented yes boundary: uncertain
  ]) {
    assert.equal((await verifyBatch([{ ...periphery, headline: abstractClaim }], clefEnv([verdict]))).accepted.size, 0);
  }
});

test('Only a confident clef yes accepts; an uncertain verdict keeps the original', async () => {
  const candidate = { ...drone, headline: 'תעשייה אווירית: ניסוי מוצלח במל״ט עם מקלע' };
  // The maximally uncertain ~0.5 verdict, and any weakly-positive probability below the
  // confident boundary, are not a yes: the candidate must keep the preserved original.
  assert.ok(CLEF_ACCEPT_PROBABILITY > 0.5 && CLEF_ACCEPT_PROBABILITY < 1);
  for (const probability of [0.5, 0.6, CLEF_ACCEPT_PROBABILITY - 0.01]) {
    assert.equal((await verifyBatch([candidate], clefEnv([{ supported: probability, preserved: 1 }]))).accepted.size, 0, `supported ${probability} must not accept`);
    assert.equal((await verifyBatch([candidate], clefEnv([{ supported: 1, preserved: probability }]))).accepted.size, 0, `preserved ${probability} must not accept`);
  }
  assert.equal((await verifyBatch([candidate], clefEnv([{ supported: CLEF_ACCEPT_PROBABILITY, preserved: CLEF_ACCEPT_PROBABILITY }]))).accepted.size, 1);
});

test('Clef answers are parsed only from the documented answers envelope', async () => {
  const byAnswer = (answer) => ({ AI: { run: async () => answer } });
  // A chat-style response (the old, wrong shape) must not be mistaken for a verdict.
  assert.equal((await verifyBatch([{ ...drone, headline: reversed }], byAnswer({ response: JSON.stringify({ items: [{ supported: true, preserved: true }] }) }))).status, 'provider_unavailable');
  assert.equal((await verifyBatch([{ ...drone, headline: reversed }], byAnswer({ result: { answers: { '0_supported': { type: 'noul', noul: 1 }, '0_preserved': { type: 'noul', noul: 1 } } } }))).accepted.size, 1);
  assert.equal((await verifyBatch([{ ...drone, headline: reversed }], byAnswer({ answers: {} }))).accepted.size, 0);
});

test('Verification is delegated only to a documented clef decision model', async () => {
  const env = { AI: { run: async () => { throw new Error('Must not run'); } } };
  const result = await verifyBatch([{ ...drone, headline: reversed }], env, { model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' });
  assert.equal(result.status, 'validator_misconfigured');
  assert.equal(result.accepted.size, 0);
});

test('Clef candidate chunks respect the documented question limit and context window', () => {
  const many = Array.from({ length: 80 }, (_, index) => ({ ...base, id: `c${index}`, headline: 'לפי המשטרה, 3 בני אדם נפצעו באירוע', context: 'א'.repeat(6000) }));
  const chunks = planVerificationBatches(many);
  assert.ok(chunks.every((chunk) => chunk.length <= CLEF_MAX_CANDIDATES));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, 80); // no candidate is dropped
  const huge = planVerificationBatches([{ ...base, id: 'huge', headline: 'כותרת', context: 'א'.repeat(24_576 * 3) }]);
  assert.equal(huge.length, 1); // the validator truncates rather than us dropping a candidate
});

test('Cross-article independence: one rejected candidate does not affect a valid sibling', async () => {
  const candidates = [
    { ...base, id: 'good', headline: 'לפי המשטרה, 3 בני אדם נפצעו באירוע' },
    { ...drone, id: 'bad', headline: reversed }
  ];
  const env = { AI: { run: async (model, input) => {
    assert.equal(input.model, 'clef-flash');
    assert.deepEqual(input.state.map((item) => item.id), ['good', 'bad']); // clear, stable per-article boundaries
    return clef([{ supported: true, preserved: true }, { supported: false, preserved: false }]);
  } } };
  const { accepted, status } = await verifyBatch(candidates, env);
  assert.deepEqual([...accepted.keys()], ['good']);
  assert.equal(status, 'partial');
});

test('Cross-article fact mixing is rejected: a sibling headline cannot move to the wrong article', async () => {
  const a = { id: 'mix-a', sourceName: 'ynet', publishedAt: '2026-10-13T11:00:00Z',
    originalHeadline: 'לפי המשטרה: 3 בני אדם נפצעו באירוע', context: 'לפי המשטרה, 3 בני אדם נפצעו באירוע.', contextCompleteness: 'complete' };
  const b = { id: 'mix-b', sourceName: 'mako', publishedAt: '2026-10-13T11:00:00Z',
    originalHeadline: 'המועצה אישרה 7 תוכניות חדשות', context: 'המועצה אישרה 7 תוכניות חדשות.', contextCompleteness: 'complete' };
  const env = { AI: { run: async (model, input) => {
    assert.deepEqual(JSON.parse(input.messages[1].content).map((item) => item.id), ['mix-a', 'mix-b']); // stable boundaries
    return { response: JSON.stringify({ items: [
      { id: 'mix-a', headline: 'המועצה אישרה 7 תוכניות חדשות', usable: true },
      { id: 'mix-b', headline: 'לפי המשטרה, 3 בני אדם נפצעו באירוע', usable: true }
    ] }) };
  } } };
  assert.equal((await rewriteBatch([a, b], env)).candidates.length, 0); // each headline is checked against its own source
});

test('No AI binding means original fallback', async () => {
  assert.equal((await rewriteBatch([base], {})).status, 'not_configured');
  assert.equal((await verifyBatch([base], {})).status, 'not_configured');
});
test('Workers AI quota or provider failure falls back without exposing raw errors', async () => {
  const env = { AI: { run: async () => { throw new Error('Quota exhausted'); } } };
  assert.equal((await rewriteBatch([base], env)).status, 'provider_unavailable');
  assert.equal((await verifyBatch([base], env)).status, 'provider_unavailable');
});
test('A structured rewrite response accepts only requested, validated items and sends full context', async () => {
  const response = await rewriteBatch([base], { AI: { run: async (model, input) => {
    assert.equal(model, DEFAULT_REWRITE_MODEL);
    assert.equal(input.temperature, 0.1);
    const sent = JSON.parse(input.messages[1].content)[0];
    assert.equal(sent.id, 'story-1');
    assert.match(sent.article, /הנסיבות נבדקות/); // full extracted body, not the 400-char excerpt
    assert.ok(input.messages[0].content.includes('material context'));
    return { response: JSON.stringify({ items: [result('לפי המשטרה, 3 בני אדם נפצעו באירוע'), { id: 'unrequested', headline: 'טקסט חיצוני', usable: true }] }) };
  } } });
  assert.equal(response.candidates.length, 1);
  assert.equal(response.candidates[0].headline, 'לפי המשטרה, 3 בני אדם נפצעו באירוע');
});
test('Rewrite reserves one complete short output per article; verification uses the clef schema', async () => {
  const items = [base, { ...base, id: 'story-2' }];
  const rewriteEnv = { AI: { run: async (model, input) => {
    assert.equal(input.max_tokens, OUTPUT_TOKENS_PER_ITEM * items.length + 32);
    return { response: JSON.stringify({ items: items.map((item) => ({ id: item.id, usable: true, headline: 'לפי המשטרה, 3 בני אדם נפצעו באירוע' })) }) };
  } } };
  const { candidates } = await rewriteBatch(items, rewriteEnv);
  assert.equal(candidates.length, 2);
  const verifyEnv = { AI: { run: async (model, input) => {
    assert.equal(input.model, 'clef-flash');
    assert.equal(input.questions['0_supported'].type, 'noul');
    assert.equal(input.questions['1_preserved'].type, 'noul');
    assert.equal(input.max_tokens, undefined); // clef has no chat output reservation
    return clef([{ supported: true, preserved: true }, { supported: true, preserved: true }]);
  } } };
  assert.equal((await verifyBatch(candidates, verifyEnv)).accepted.size, 2);
});

test('Malformed or duplicate model items fall back cleanly', async () => {
  assert.equal((await rewriteBatch([base], { AI: { run: async () => ({ response: 'not json' }) } })).status, 'invalid_response');
  const duplicate = await rewriteBatch([base], { AI: { run: async () => ({ response: { items: [result('לפי המשטרה, 3 בני אדם נפצעו באירוע'), result('לפי המשטרה, 3 בני אדם נפצעו באירוע')] } }) } });
  assert.equal(duplicate.candidates.length, 0);
});
test('Expensive models are blocked before inference; Qwen3 is an allowed cheap model', async () => {
  const AI = { run: () => { throw new Error('Must not run'); } };
  assert.equal((await rewriteBatch([base], { AI, REWRITE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })).status, 'budget_guard');
  const qwen = await rewriteBatch([base], { AI: { run: async (model, input) => {
    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
    assert.equal(input.chat_template_kwargs.enable_thinking, false); // documented thinking-off option
    assert.match(input.messages[0].content, /\/no_think/);
    return { choices: [{ message: { content: JSON.stringify({ items: [result('לפי המשטרה, 3 בני אדם נפצעו באירוע')] }) } }] }; // chat-shaped response
  } } }, { model: '@cf/qwen/qwen3-30b-a3b-fp8' });
  assert.equal(qwen.candidates.length, 1);
});
test('Model responses are parsed across documented envelope shapes', () => {
  assert.equal(parseModelText({ response: 'a' }), 'a');
  assert.equal(parseModelText({ result: { response: 'b' } }), 'b');
  assert.equal(parseModelText({ output_text: 'c' }), 'c');
  assert.equal(parseModelText({ choices: [{ message: { content: 'd' } }] }), 'd');
  assert.equal(parseModelText({ response: { items: [] } }), '{"items":[]}');
  assert.deepEqual(parseJsonObject('```json\n{"items":[]}\n```'), { items: [] });
  assert.deepEqual(parseJsonObject('sure: {"items":[{"id":"1"}]} thanks'), { items: [{ id: '1' }] });
  assert.equal(parseJsonObject('no json here'), null);
});
test('Qwen3 chat envelopes resolve under top-level, result and response wrappers', () => {
  const content = JSON.stringify({ items: [{ id: 'story-1', headline: 'לפי המשטרה, 3 בני אדם נפצעו באירוע', usable: true }] });
  assert.equal(parseModelText({ choices: [{ message: { content, reasoning_content: 'מחשבה' } }] }), content);
  assert.equal(parseModelText({ choices: [{ text: content }] }), content);
  assert.equal(parseModelText({ result: { choices: [{ message: { content } }] } }), content);
  assert.equal(parseModelText({ response: { choices: [{ message: { content } }] } }), content);
  // A thinking-only answer with no content must not be mistaken for the JSON result.
  assert.equal(parseModelText({ choices: [{ message: { content: '', reasoning_content: 'סיבה' } }] }), '');
  assert.ok(modelUsageNeurons({ result: { usage: { prompt_tokens: 1000, completion_tokens: 100 } } }, '@cf/qwen/qwen3-30b-a3b-fp8') > 0);
});
test('A nested Qwen3 chat response is accepted through the rewrite batch', async () => {
  const env = { AI: { run: async (model) => {
    assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
    return { result: { choices: [{ message: { content: JSON.stringify({ items: [result('לפי המשטרה, 3 בני אדם נפצעו באירוע')] }) } }] } };
  } } };
  const { candidates } = await rewriteBatch([base], env, { model: '@cf/qwen/qwen3-30b-a3b-fp8' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].headline, 'לפי המשטרה, 3 בני אדם נפצעו באירוע');
});
test('Prompts require the primary point and material context, and separate verification questions', () => {
  assert.match(EDITORIAL_PROMPT, /material context/);
  assert.match(EDITORIAL_PROMPT, /never reverse an outcome/);
  // Clef is asked two separate typed yes/no questions per candidate.
  assert.equal(VERIFICATION_QUESTIONS.supported.type, 'noul');
  assert.equal(VERIFICATION_QUESTIONS.preserved.type, 'noul');
  assert.match(VERIFICATION_QUESTIONS.supported.instructions, /Supported:/);
  assert.match(VERIFICATION_QUESTIONS.preserved.instructions, /Preserved:/);
  assert.match(VERIFICATION_PROMPT, /supported/i);
  assert.match(VERIFICATION_PROMPT, /preserved/i);
});
