import 'dotenv/config';
import { emitKeypressEvents } from 'node:readline';
import { createDatabase } from '../storage/database.js';
import { parseConfig } from '../config.js';
import { bootstrapAdmin } from './service.js';
import { AppError } from '../errors.js';

async function hiddenPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Use an interactive terminal for password entry.');
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    let overflow = false;
    const done = () => {
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const keypress = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') {
        done();
        reject(new Error('Provisioning cancelled.'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        done();
        if (overflow) reject(new Error('Password too long.'));
        else resolve(value);
        return;
      }
      if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (
        text &&
        !key.ctrl &&
        !overflow &&
        Array.from(text).every(
          (character) =>
            character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127,
        )
      ) {
        value += text;
        if (value.length > 128) {
          overflow = true;
          value = '';
        }
      }
    };
    process.stdin.on('keypress', keypress);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--username')
    throw new Error(
      'Usage: npm run admin:bootstrap -- --username YOUR_USERNAME',
    );
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    !/^postgres(ql)?:\/\//.test(databaseUrl) ||
    /REPLACE/i.test(databaseUrl)
  )
    throw new Error('Set DATABASE_URL in backend/.env locally first.');
  // This trusted DB command needs no model key or session signing key.
  const config = parseConfig({
    NODE_ENV: 'development',
    ...(process.env.USER_DAILY_REQUEST_LIMIT
      ? { USER_DAILY_REQUEST_LIMIT: process.env.USER_DAILY_REQUEST_LIMIT }
      : {}),
    ...(process.env.USER_DAILY_TOKEN_LIMIT
      ? { USER_DAILY_TOKEN_LIMIT: process.env.USER_DAILY_TOKEN_LIMIT }
      : {}),
    ...(process.env.USER_DAILY_COST_LIMIT_INR
      ? { USER_DAILY_COST_LIMIT_INR: process.env.USER_DAILY_COST_LIMIT_INR }
      : {}),
  });
  const password = await hiddenPrompt(
    'Admin password (12–128 characters; hidden): ',
  );
  const confirmation = await hiddenPrompt('Confirm password (hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  const db = createDatabase(databaseUrl);
  try {
    await bootstrapAdmin(db, config, args[1]!, password);
  } finally {
    await db.$disconnect();
  }
  process.stdout.write(
    'First administrator created. Sign in with your chosen username and password.\n',
  );
}

main().catch((error: unknown) => {
  const safe =
    error instanceof AppError
      ? error.message
      : 'Admin provisioning failed. Check the command, local database configuration, migrations, and password requirements.';
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
