import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptRewrite, DEFAULT_REWRITE_MODEL, rewriteBatch } from '../src/rewrite.js';

const article = { id: 'story-1', originalHeadline: 'לפי המשטרה: 3 בני אדם נפצעו באירוע', description: 'המשטרה מסרה כי הנסיבות נבדקות.' };
const result = (headline) => ({ id: '0', headline, usable: true });

test('Factual dry headlines preserve numbers and attribution', () => {
  assert.equal(acceptRewrite(article, result('לפי המשטרה, 3 בני אדם נפצעו באירוע')), 'לפי המשטרה, 3 בני אדם נפצעו באירוע');
});
test('Changed numbers, dropped attribution, certainty changes and emotional output are rejected', () => {
  for (const headline of ['לפי המשטרה, 5 בני אדם נפצעו', 'לפי המשטרה, אנשים נפצעו', '3 בני אדם נפצעו באירוע', 'לפי המשטרה, 3 בני אדם נפצעו!']) assert.equal(acceptRewrite(article, result(headline)), null);
  const allegation = { ...article, originalHeadline: 'חשד להונאה: 3 בני אדם נעצרו' };
  assert.equal(acceptRewrite(allegation, result('3 בני אדם נעצרו בגין הונאה')), null);
  assert.equal(acceptRewrite(allegation, result('3 בני אדם נעצרו בחשד להונאה')), '3 בני אדם נעצרו בחשד להונאה');
});
test('A rewrite may not introduce rhetorical questions or new sensational framing', () => {
  assert.equal(acceptRewrite(article, result('מה קרה באירוע שבו נפצעו 3 בני אדם?')), null);
  assert.equal(acceptRewrite(article, result('בהלם: לפי המשטרה, 3 בני אדם נפצעו באירוע')), null);
  assert.equal(acceptRewrite(article, result('מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע')), null);
  const alreadySensational = { ...article, originalHeadline: 'מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע' };
  assert.equal(acceptRewrite(alreadySensational, result('מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע')), 'מזעזע: לפי המשטרה, 3 בני אדם נפצעו באירוע');
});
test('No AI binding means original fallback', async () => {
  const response = await rewriteBatch([article], {});
  assert.equal(response.status, 'not_configured'); assert.equal(response.results.size, 0);
});
test('Workers AI quota or provider failure falls back without exposing raw errors', async () => {
  const response = await rewriteBatch([article], { AI: { run: async () => { throw new Error('Quota exhausted'); } } });
  assert.equal(response.status, 'provider_unavailable'); assert.equal(response.results.size, 0);
});
test('A structured model response accepts only requested, unique, validated items', async () => {
  const response = await rewriteBatch([article], { AI: { run: async (model, input) => {
    assert.equal(model, DEFAULT_REWRITE_MODEL);
    assert.equal(input.max_tokens, 1024);
    assert.equal(JSON.parse(input.messages[1].content)[0].id, '0');
    return { response: JSON.stringify({ items: [result('לפי המשטרה, 3 בני אדם נפצעו'), { id: 'unrequested', headline: 'טקסט חיצוני', usable: true }] }) };
  } } });
  assert.equal(response.results.get(article.id), 'לפי המשטרה, 3 בני אדם נפצעו'); assert.equal(response.results.size, 1);
});
test('Malformed or duplicate model items fall back cleanly', async () => {
  const malformed = await rewriteBatch([article], { AI: { run: async () => ({ response: 'not json' }) } });
  assert.equal(malformed.status, 'invalid_response');
  const duplicate = await rewriteBatch([article], { AI: { run: async () => ({ response: { items: [result('לפי המשטרה, 3 בני אדם נפצעו'), result('לפי המשטרה, 3 בני אדם נפצעו')] } }) } });
  assert.equal(duplicate.results.size, 0);
});
test('Expensive models and oversized batches are blocked before inference', async () => {
  const AI = { run: () => { throw new Error('Must not run'); } };
  assert.equal((await rewriteBatch([article], { AI, REWRITE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' })).status, 'budget_guard');
  assert.equal((await rewriteBatch(Array(9).fill(article), { AI })).status, 'budget_guard');
});
