import test from 'node:test';
import assert from 'node:assert/strict';
import { meaningfulRewrite } from '../src/headline-change.ts';
import { acceptRewrite } from '../src/rewrite.ts';
import { policyFingerprint, retireStaleRewrites } from '../src/policy.ts';

test('Quote, separator, whitespace and diacritic changes do not count as rewrites', () => {
  for (const [source, cosmetic] of [
    ['טראמפ בעצרת: "חכו ותראו מה נעשה"', 'טראמפ בעצרת: חכו ותראו מה נעשה'],
    ['התחממות קלה | התחזית המלאה', 'התחממות קלה; התחזית המלאה'],
    ['טיסה לנתב"ג', 'טיסה לנתב״ג'],
    ['תל־אביב', 'תל אביב'],
    ['המשטרה: 3 נעצרו', 'המשטרה,  3 נעצרו']
  ]) assert.equal(meaningfulRewrite(source, cosmetic), false);
  assert.equal(meaningfulRewrite('המועצה: 3 תוכניות אושרו', 'המועצה אישרה 3 תוכניות'), true);
});

test('Cosmetic model output is rejected and existing cosmetic decisions retire without inference', () => {
  const source = 'טראמפ בעצרת: "חכו ותראו מה נעשה באיראן"';
  const cosmetic = 'טראמפ בעצרת: חכו ותראו מה נעשה באיראן';
  assert.equal(acceptRewrite({id:'quote', originalHeadline:source}, {usable:true, headline:cosmetic}), null);
  const {articles, changed} = retireStaleRewrites([{id:'quote',originalHeadline:source,headline:cosmetic,
    rewriteStatus:'rewritten',rewriteFingerprint:policyFingerprint()}], policyFingerprint());
  assert.equal(changed, true);
  assert.equal(articles[0].headline, source);
  assert.equal(articles[0].rewriteStatus, 'original');
});
