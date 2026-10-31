import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export async function prepare(root) {
  const messages = [];
  async function create(path, content) {
    try {
      await writeFile(join(root, path), content, { flag: 'wx', mode: 0o600 });
      messages.push(`Created ${path}`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      messages.push(`Preserved existing ${path}`);
    }
  }
  const template = (path) => readFile(join(root, path), 'utf8');
  await create(
    '.env',
    (await template('.env.example')).replace(
      'REPLACE_WITH_LOCALLY_GENERATED_PASSWORD',
      randomBytes(32).toString('hex'),
    ),
  );
  const env = parseEnv(await template('.env'));
  if (
    !env.POSTGRES_PASSWORD ||
    /REPLACE|CHANGE_ME/i.test(env.POSTGRES_PASSWORD) ||
    !/^[a-zA-Z0-9_-]{20,}$/.test(env.POSTGRES_PASSWORD)
  )
    throw new Error(
      'Set a root .env POSTGRES_PASSWORD of at least 20 URL-safe characters (letters, digits, underscore or hyphen). Existing files were preserved.',
    );
  for (const field of ['POSTGRES_USER', 'POSTGRES_DB'])
    if (env[field] && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(env[field]))
      throw new Error(
        `Use letters, digits and underscore for ${field} in root .env.`,
      );
  const user = env.POSTGRES_USER ?? 'query_assistant',
    database = env.POSTGRES_DB ?? 'query_assistant';
  const backend = (await template('backend/.env.example'))
    .replace(
      'postgresql://REPLACE_USER:REPLACE_PASSWORD@REPLACE_HOST:5432/query_assistant',
      `postgresql://${user}:${env.POSTGRES_PASSWORD}@127.0.0.1:5432/${database}`,
    )
    .replace(
      'GEMINI_API_KEY=REPLACE_LOCALLY',
      '# GEMINI_API_KEY=Enter_your_paid_key_locally',
    )
    .replace(
      'REPLACE_WITH_LOCALLY_GENERATED_SECRET',
      randomBytes(48).toString('base64url'),
    );
  await create('backend/.env', backend);
  await create('frontend/.env', await template('frontend/.env.example'));
  await mkdir(join(root, '.local'), { recursive: true });
  return messages;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const messages = await prepare(
      fileURLToPath(new URL('..', import.meta.url)),
    );
    process.stdout.write(
      messages.join('\n') +
        '\nEnter GEMINI_API_KEY locally in backend/.env before starting the complete stack. No secret values were displayed. See LOCAL_SETUP.md.\n',
    );
  } catch (error) {
    // Only the explicit non-secret configuration guidance above is printable.
    const message =
      error instanceof Error && /^(Set a root|Use letters)/.test(error.message)
        ? error.message
        : 'Setup failed. Check file permissions and the example files. Existing files were preserved.';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}
