import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
import { prepare } from './setup.mjs';

test('clean setup creates private configuration and repeated setup preserves operator secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-setup-'));
  for (const dir of ['backend', 'frontend']) await mkdir(join(root, dir));
  for (const path of [
    '.env.example',
    'backend/.env.example',
    'frontend/.env.example',
  ])
    await copyFile(path, join(root, path));
  await prepare(root);
  const names = ['.env', 'backend/.env', 'frontend/.env'];
  const before = await Promise.all(
    names.map((p) => readFile(join(root, p), 'utf8')),
  );
  const backend = parseEnv(before[1]),
    db = parseEnv(before[0]);
  assert.ok(backend.DATABASE_URL.includes(db.POSTGRES_PASSWORD));
  assert.ok(backend.JWT_SIGNING_KEY.length >= 64);
  assert.equal(backend.GEMINI_API_KEY, undefined);
  const messages = await prepare(root);
  assert.ok(messages.every((m) => m.startsWith('Preserved')));
  assert.deepEqual(
    await Promise.all(names.map((p) => readFile(join(root, p), 'utf8'))),
    before,
  );
  if (process.platform !== 'win32')
    for (const p of names)
      assert.equal((await stat(join(root, p))).mode & 0o777, 0o600);
});

test('setup rejects an existing placeholder without overwriting local configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-setup-invalid-'));
  await copyFile('.env.example', join(root, '.env.example'));
  const original =
    'POSTGRES_PASSWORD=REPLACE_WITH_LOCALLY_GENERATED_PASSWORD\n';
  await writeFile(join(root, '.env'), original);
  await assert.rejects(prepare(root), /Set a root/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), original);
});
