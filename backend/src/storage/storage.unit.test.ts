import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyPeriod } from './period.js';
import { estimateCost, fromNano, toNano } from './money.js';

test('nano-unit money preserves tiny costs without floating-point rounding', () => {
  assert.equal(fromNano(toNano('0.000000001')), '0.000000001');
  assert.equal(fromNano(toNano('100')), '100');
  assert.throws(() => toNano('0.0000000001'));
  const result = estimateCost(1, 1, {
    inputNanoUsdPerMillion: toNano('0.30'),
    outputNanoUsdPerMillion: toNano('2.50'),
    inrPerUsdNano: toNano('100'),
  });
  assert.equal(fromNano(result.nanoUsd), '0.0000028');
  assert.equal(fromNano(result.nanoInr), '0.00028');
});
test('daily periods reset at Kolkata midnight and settle into the original day', () => {
  const before = dailyPeriod(
    new Date('2026-10-30T18:29:59.999Z'),
    'Asia/Kolkata',
  );
  const after = dailyPeriod(
    new Date('2026-10-30T18:30:00.000Z'),
    'Asia/Kolkata',
  );
  assert.equal(before.start.toISOString(), '2026-10-29T18:30:00.000Z');
  assert.equal(before.end.toISOString(), after.start.toISOString());
  assert.equal(after.end.toISOString(), '2026-10-31T18:30:00.000Z');
});
test('timezone periods handle daylight-saving days without assuming 24 hours', () => {
  const spring = dailyPeriod(
    new Date('2026-03-08T12:00:00Z'),
    'America/New_York',
  );
  const fall = dailyPeriod(
    new Date('2026-11-01T12:00:00Z'),
    'America/New_York',
  );
  assert.equal(spring.end.getTime() - spring.start.getTime(), 23 * 3600000);
  assert.equal(fall.end.getTime() - fall.start.getTime(), 25 * 3600000);
});
