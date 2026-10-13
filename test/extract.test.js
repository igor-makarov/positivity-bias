import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_CHARS, prepareContext } from '../src/extract.js';

test('Context completeness is tracked honestly instead of describing an excerpt as the article', () => {
  assert.deepEqual(prepareContext(''), { text: '', charCount: 0, completeness: 'missing' });
  assert.equal(prepareContext('<p>שלום</p>').completeness, 'complete');
  const short = prepareContext('טקסט קצר');
  assert.equal(short.text, 'טקסט קצר');
  assert.equal(short.completeness, 'complete');
  const long = prepareContext('א'.repeat(DEFAULT_CONTEXT_CHARS + 500));
  assert.equal(long.completeness, 'truncated');
  assert.equal(long.text.length, DEFAULT_CONTEXT_CHARS);
  assert.ok(long.charCount > DEFAULT_CONTEXT_CHARS);
});
test('Context is bounded plain text without markup', () => {
  assert.equal(prepareContext('<script>evil()</script><p>כותרת &amp; גוף</p>').text, 'כותרת & גוף');
});
