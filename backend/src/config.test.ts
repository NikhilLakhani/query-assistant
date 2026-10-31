import assert from 'node:assert/strict';
import test from 'node:test';
import { hasServiceConfiguration, parseConfig } from './config.js';

test('bootstrap defaults do not imply paid-service configuration', () => {
  const config = parseConfig({});
  assert.equal(config.PORT, 3001);
  assert.equal(hasServiceConfiguration(config), false);
});
test('invalid configuration fails without echoing secret values', () => {
  const badSecret = 'REPLACE_PRIVATE_MATERIAL';
  assert.throws(
    () => parseConfig({ GEMINI_API_KEY: badSecret }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /GEMINI_API_KEY/);
      assert.ok(!error.message.includes(badSecret));
      return true;
    },
  );
  for (const env of [
    { PORT: '0' },
    { FRONTEND_ORIGIN: '*' },
    { DISPLAY_TIMEZONE: 'bad-zone' },
    { MAX_OUTPUT_TOKENS: '2001' },
    { STREAM_IDLE_TIMEOUT_SECONDS: '20', GENERATION_TIMEOUT_SECONDS: '10' },
  ]) {
    assert.throws(() => parseConfig(env));
  }
});
test('production refuses missing secrets and HTTP frontend origins', () => {
  assert.throws(() => parseConfig({ NODE_ENV: 'production' }));
  assert.throws(() => parseConfig({ ACCOUNTING_INR_PER_USD: '0' }));
  assert.throws(() => parseConfig({ JWT_SIGNING_KEY: 'short' }));
  // Synthetic test-only configuration, never a working credential or connection.
  const configured = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@localhost/test',
    GEMINI_API_KEY: 'synthetic-test-value',
    JWT_SIGNING_KEY: 'synthetic-signing-material-for-tests-only',
    ACCOUNTING_INR_PER_USD: '1',
    FRONTEND_ORIGIN: 'https://app.example',
  };
  assert.equal(hasServiceConfiguration(parseConfig(configured)), true);
  assert.throws(() =>
    parseConfig({ ...configured, FRONTEND_ORIGIN: 'http://app.example' }),
  );
});
