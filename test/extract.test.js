import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_CHARS, MIN_CONTEXT_CHARS, prepareContext } from '../src/extract.js';

const article = 'המועצה אישרה שלוש תוכניות חדשות. '.repeat(4);

test('Context completeness is tracked honestly instead of describing an excerpt as the article', () => {
  assert.deepEqual(prepareContext(''), { text: '', charCount: 0, completeness: 'missing' });
  const complete = prepareContext(`<p>${article}</p>`);
  assert.equal(complete.completeness, 'complete');
  assert.equal(complete.text, article.trim());
  const long = prepareContext('א'.repeat(DEFAULT_CONTEXT_CHARS + 500));
  assert.equal(long.completeness, 'truncated');
  assert.equal(long.text.length, DEFAULT_CONTEXT_CHARS);
  assert.ok(long.charCount > DEFAULT_CONTEXT_CHARS);
});

test('Thin navigation or stub text is treated as missing, never as the article', () => {
  const thin = prepareContext('תפריט האתר דלג לתוכן העמוד קישורים תחתונים');
  assert.ok('תפריט האתר דלג לתוכן העמוד קישורים תחתונים'.length < MIN_CONTEXT_CHARS);
  assert.equal(thin.completeness, 'missing');
  assert.equal(thin.text, '');
});

test('Bot-challenge and access-denied interstitials are never inference context', () => {
  for (const page of [
    'We are sorry... but your activity and behavior on this website made us think that you are a bot. To protect this website, we cannot process your request right now.',
    'Please solve this CAPTCHA in helping us understand your behavior to grant access.',
    'Access to this page has been denied because we believe you are using automation tools.'
  ]) {
    const result = prepareContext(page);
    assert.equal(result.completeness, 'missing');
    assert.equal(result.text, '');
  }
});

test('Context is bounded plain text without markup', () => {
  assert.equal(prepareContext(`<script>evil()</script><p>${article} &amp; עוד</p>`).text, `${article.trim()} & עוד`);
});
