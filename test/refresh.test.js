import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { refreshDue, REFRESH_MINUTE } from '../src/refresh.js';

test('A reader refresh between ticks does not suppress the next hourly cron', () => {
  const last = '2026-10-13T18:42:17.042Z';
  assert.equal(refreshDue(last, Date.parse('2026-10-13T19:06:59.999Z')), false);
  assert.equal(refreshDue(last, Date.parse('2026-10-13T19:07:00.000Z')), true);
  assert.equal(refreshDue('2026-10-13T19:07:00.000Z', Date.parse('2026-10-13T19:42:00Z')), false);
});

test('Failed attempts, clock rollback and reads stay bounded in the same cron window', () => {
  const last = '2026-10-13T18:07:00Z';
  assert.equal(refreshDue(last, Date.parse('2026-10-13T19:06:59Z')), false);
  assert.equal(refreshDue(last, Date.parse('2026-10-13T19:07:00Z')), true);
  assert.equal(refreshDue(last, Date.parse('2026-10-13T17:07:00Z')), false);
  assert.equal(refreshDue(null), true);
  assert.equal(refreshDue('invalid'), true);
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url)));
  assert.deepEqual(config.triggers.crons, [`${REFRESH_MINUTE} * * * *`]);
});
