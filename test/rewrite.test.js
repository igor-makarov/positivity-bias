import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRewrite, DEFAULT_REWRITE_MODEL, EDITORIAL_PROMPT, VERIFICATION_PROMPT, parseJsonObject, parseModelText, rewriteBatch, verifyBatch } from '../src/rewrite.js';
import { DEFAULT_VALIDATOR_MODEL } from '../src/policy.js';

const base = { id: 'story-1', sourceName: 'ynet', publishedAt: '2026-10-13T11:00:00Z',
  originalHeadline: 'לפי המשטרה: 3 בני אדם נפצעו באירוע',
  context: 'המשטרה מסרה כי הנסיבות נבדקות. לפי המשטרה, 3 בני אדם נפצעו באירוע.',
  contextCompleteness: 'complete' };
const result = (headline, extra = {}) => ({ id: 'story-1', headline, usable: true, ...extra });

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
  const env = { AI: { run: async (model) => {
    assert.equal(model, DEFAULT_VALIDATOR_MODEL);
    return { response: JSON.stringify({ items: [{ id: 'drone-1', supported: false, preserved: true }] }) };
  } } };
  const { accepted, status } = await verifyBatch([{ ...drone, headline: reversed }], env);
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
  const env = { AI: { run: async () => ({ response: JSON.stringify({ items: [{ id: 'north-1', supported: true, preserved: false }] }) }) } };
  const { accepted } = await verifyBatch([{ ...periphery, headline: abstractClaim }], env);
  assert.equal(accepted.size, 0);
});
test('A faithful rewrite that keeps the speakers and the tourism point is accepted', async () => {
  const faithful = 'ראשי הערים מכרמיאל ומדימונה: הצפון נתפס כצימר לסופ״ש ולא כמקום לגור בו';
  const env = { AI: { run: async (model, input) => {
    const request = JSON.parse(input.messages[1].content)[0];
    assert.match(request.article, /כרמיאל/); // full article context is sent to the validator
    assert.ok(input.messages[0].content.includes('preserved'));
    return { response: JSON.stringify({ items: [{ id: 'north-1', supported: true, preserved: true }] }) };
  } } };
  const { accepted } = await verifyBatch([{ ...periphery, headline: faithful }], env);
  assert.equal(accepted.get('north-1'), faithful);
});

test('Verification rejects a merely plausible but incomplete or uncertain candidate', async () => {
  for (const verdict of [
    { id: 'north-1', supported: true, preserved: false },
    { id: 'north-1', supported: false, preserved: true },
    { id: 'north-1', supported: true }
  ]) {
    const env = { AI: { run: async () => ({ response: JSON.stringify({ items: [verdict] }) }) } };
    assert.equal((await verifyBatch([{ ...periphery, headline: abstractClaim }], env)).accepted.size, 0);
  }
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
test('Prompts require the primary point and material context, and separate verification questions', () => {
  assert.match(EDITORIAL_PROMPT, /material context/);
  assert.match(EDITORIAL_PROMPT, /never reverse an outcome/);
  assert.match(VERIFICATION_PROMPT, /supported/);
  assert.match(VERIFICATION_PROMPT, /preserved/);
});
