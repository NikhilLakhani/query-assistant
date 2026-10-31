import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseEnv } from 'node:util';

const [mode, path, ...args] = process.argv.slice(2);
const run = (command, input, output) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', ...command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    // Never forward database diagnostics or expanded configuration to the terminal.
    child.stderr.resume();
    child.once('error', () =>
      reject(new Error('Docker Compose could not start.')),
    );
    const ended = new Promise((done, fail) =>
      child.once('close', (code) =>
        code === 0
          ? done()
          : fail(
              new Error(
                'Database operation failed. Check service state, file and target name.',
              ),
            ),
      ),
    );
    const transfer = output
      ? pipeline(child.stdout, output)
      : Promise.resolve(child.stdout.resume());
    const incoming = input
      ? pipeline(input, child.stdin)
      : Promise.resolve(child.stdin.end());
    Promise.all([ended, transfer, incoming])
      .then(resolve)
      .catch((error) => {
        child.kill('SIGTERM');
        reject(error);
      });
  });
try {
  if (!['backup', 'restore'].includes(mode) || !path)
    throw new Error(
      'Usage: npm run db:backup -- backups/FILE.dump | npm run db:restore -- backups/FILE.dump --database NEW_DATABASE',
    );
  const file = resolve(path);
  if (mode === 'backup') {
    if (args.length) throw new Error('Backup accepts only an output path.');
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file, 'wx', 0o600);
    try {
      await run(
        [
          'db',
          'sh',
          '-c',
          'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom',
        ],
        null,
        handle.createWriteStream(),
      );
    } catch {
      throw new Error(
        'Backup failed. The new output may be incomplete; inspect it before retaining it. Existing files were not overwritten.',
      );
    }
    process.stdout.write(
      'Database backup saved. Treat the dump as sensitive; it includes chats, credentials hashes and accounting.\n',
    );
  } else {
    if (
      args.length !== 2 ||
      args[0] !== '--database' ||
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(args[1])
    )
      throw new Error(
        'Restore requires --database NEW_DATABASE using letters, digits and underscore.',
      );
    if (!(await stat(file)).isFile())
      throw new Error('Restore input must be a file.');
    const env = parseEnv(await readFile('.env', 'utf8'));
    if (args[1] === (env.POSTGRES_DB ?? 'query_assistant'))
      throw new Error(
        'Restore refuses the configured application database. Choose a fresh database name.',
      );
    const prefix = ['-e', `RESTORE_DATABASE=${args[1]}`, 'db', 'sh', '-c'];
    await run([
      ...prefix,
      'exec createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$RESTORE_DATABASE"',
    ]);
    await run(
      [
        ...prefix,
        'exec pg_restore -U "$POSTGRES_USER" --dbname="$RESTORE_DATABASE" --no-owner --no-privileges --single-transaction --exit-on-error',
      ],
      createReadStream(file),
    );
    process.stdout.write(
      'Backup restored into the new database. The application still uses its original database. Verify the copy before any deliberate cutover.\n',
    );
  }
} catch (error) {
  const message =
    error instanceof Error &&
    /^(Usage:|Backup accepts|Backup failed|Restore |Docker Compose|Database operation)/.test(
      error.message,
    )
      ? error.message
      : 'Database copy failed. Check Docker, file permissions and LOCAL_SETUP.md; no existing database is automatically removed.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
