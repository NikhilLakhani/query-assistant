import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (name) => readFile(resolve(root, name), 'utf8');
const required = [
  'README.md',
  'LOCAL_SETUP.md',
  'DEPLOYMENT.md',
  'docs/CONFIGURATION.md',
  'docs/API.md',
  'docs/AUTH.md',
  'docs/STORAGE.md',
  'docs/SECURITY.md',
  '.env.example',
  'backend/.env.example',
  'frontend/.env.example',
  'backend/Dockerfile',
  'frontend/Dockerfile',
  '.dockerignore',
  'compose.yaml',
  'compose.dev.yaml',
  '.nvmrc',
  'package-lock.json',
  '.github/workflows/ci.yml',
  'scripts/setup.mjs',
  'scripts/database-copy.mjs',
  'backend/src/auth/provision-admin.ts',
  'backend/prisma/schema.prisma',
];
for (const path of required) await access(resolve(root, path));
const migrationDirs = await readdir(
  resolve(root, 'backend/prisma/migrations'),
  { withFileTypes: true },
);
assert(
  migrationDirs.some((entry) => entry.isDirectory()),
  'Committed migrations required',
);

const configKeys = [
  ...(await read('backend/src/config.ts')).matchAll(
    /^ {4}([A-Z][A-Z0-9_]+):/gm,
  ),
].map((match) => match[1]);
const example = parseEnv(await read('backend/.env.example'));
assert.deepEqual(
  Object.keys(example).sort(),
  [...configKeys].sort(),
  'Backend example must cover the complete schema',
);
const reference = await read('docs/CONFIGURATION.md');
for (const key of [
  ...configKeys,
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'VITE_API_BASE_URL',
])
  assert(
    reference.includes('`' + key + '`'),
    `Missing configuration explanation: ${key}`,
  );
assert.deepEqual(Object.keys(parseEnv(await read('frontend/.env.example'))), [
  'VITE_API_BASE_URL',
]);
assert.deepEqual(Object.keys(parseEnv(await read('.env.example'))).sort(), [
  'POSTGRES_DB',
  'POSTGRES_PASSWORD',
  'POSTGRES_USER',
]);

const packageJson = JSON.parse(await read('package.json'));
const docs = required.filter((name) => name.endsWith('.md'));
let links = 0;
for (const name of docs) {
  const text = await read(name);
  // Check repository-relative inline links/images, without fetching external URLs.
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    const path = resolve(
      dirname(resolve(root, name)),
      decodeURIComponent(target.split('#')[0]),
    );
    assert(
      !relative(root, path).startsWith('..'),
      `Link escapes repository: ${name}`,
    );
    await access(path);
    links++;
  }
  for (const match of text.matchAll(/npm run ([a-z][a-z0-9:-]*)([^\n`]*)/g)) {
    if (/(?: -w | --workspace)/.test(match[2])) continue;
    assert(
      Object.hasOwn(packageJson.scripts, match[1]),
      `Unknown root npm script ${match[1]} in ${name}`,
    );
  }
}
console.log(
  `Documentation checks passed: ${required.length} deliverables, ${configKeys.length} backend settings, ${links} local links and documented root npm scripts. External links and cloud execution require separate review.`,
);
