import test from 'node:test';
import assert from 'node:assert/strict';
import { minimalHeadline } from '../src/minimal-headline.ts';
import { rewriteBatch, verifyBatch } from '../src/rewrite.ts';
import type { AIInput } from '../src/types.ts';

test('A minimal candidate removes standalone click prompts and retains every factual clause', () => {
  assert.equal(minimalHeadline('נתניהו ביקר בקטאר אך הכחיש שנפגש עם נציגי חמאס | כל הפרטים'),
    'נתניהו ביקר בקטאר אך הכחיש שנפגש עם נציגי חמאס');
  assert.equal(minimalHeadline('תינוק נפצע אנושות; המשטרה חוקרת | צפו'), 'תינוק נפצע אנושות; המשטרה חוקרת');
  assert.equal(minimalHeadline('המועצה אישרה תוכנית חדשה'), null);
  assert.equal(minimalHeadline('המשטרה מסרה כי התיעוד אינו עדכני'), null);
  assert.equal(minimalHeadline('תושבים צפו בניסוי שנערך בעיר'), null);
  assert.equal(minimalHeadline('ראש העיר: "לא נפסיק את העבודות" | תגובת התושבים'),
    null);
});

test('Minimal candidates use the same full-context validation and never bypass factual rejection', async () => {
  const originalHeadline = 'נתניהו ביקר בקטאר אך הכחיש שנפגש עם נציגי חמאס | כל הפרטים';
  const item = { id: 'denial', originalHeadline, contextCompleteness: 'complete',
    context: 'נתניהו ביקר בקטאר. הוא הכחיש שנפגש עם נציגי חמאס. הודעת לשכתו פירטה את הביקור ואת הכחשת הפגישה. לא נמסר אישור עצמאי לקיומה של פגישה עם נציגי חמאס.' };
  const rewritten = await rewriteBatch([item], { AI: { run: async () => ({items: [{id: '0', usable: true,
    headlines: ['נתניהו ביקר בקטאר', 'נתניהו נפגש עם נציגי חמאס', 'ביקור נתניהו בקטאר']}]}) } });
  assert.equal(rewritten.candidates.length, 1);
  assert.deepEqual(rewritten.candidates[0].headlines, [minimalHeadline(originalHeadline)]);
  let calls = 0;
  const result = await verifyBatch(rewritten.candidates, {AI: {run: async (_model: string, input: AIInput) => {
    calls++;
    assert.equal(input.state![0].article, item.context);
    return {answers: {'0_headline': {type: 'choice', choice: 'original', confidence: 1,
      probabilities: {option_1: 0, original: 1}}, '0_option_1_supported': {noul: 1}, '0_option_1_preserved': {noul: 0}, '0_option_1_readable': {noul: 1}}};
  }}});
  assert.equal(calls, 1);
  assert.equal(result.accepted.size, 0);
  assert.ok(result.rejected.has(item.id));
});
