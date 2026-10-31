import assert from 'node:assert/strict';
import test from 'node:test';
import { Drafts } from './drafts';
test('drafts keep conversations separate and clear without writing browser storage', () => {
  const drafts = new Drafts();
  drafts.set('new', 'New question');
  drafts.set('chat-a', 'Follow up');
  assert.equal(drafts.get('new'), 'New question');
  assert.equal(drafts.get('chat-a'), 'Follow up');
  drafts.set('chat-a', '');
  assert.equal(drafts.get('chat-a'), '');
  drafts.clear();
  assert.equal(drafts.get('new'), '');
});
test('drafts bound retained text and evict oldest entries', () => {
  const drafts = new Drafts();
  drafts.set('old', 'old');
  for (let n = 0; n < 20; n++) drafts.set(String(n), 'x'.repeat(9000));
  assert.equal(drafts.get('old'), '');
  assert.equal(drafts.get('19').length, 8000);
  drafts.remove('19');
  assert.equal(drafts.get('19'), '');
});
