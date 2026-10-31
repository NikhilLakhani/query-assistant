import 'dotenv/config';
import { buildApp } from './app.js';
import { ConfigurationError, parseConfig } from './config.js';
import { createDatabase } from './storage/database.js';
import { Storage } from './storage/store.js';

async function start() {
  const config = parseConfig(process.env);
  const database = config.DATABASE_URL
    ? createDatabase(config.DATABASE_URL)
    : undefined;
  const app = buildApp(config, database ? { database } : {});
  if (database) {
    const storage = new Storage(database, config);
    let recovery: Promise<void> | undefined;
    const recover = () => {
      if (recovery) return;
      recovery = storage
        .recoverExpired(10)
        .then((count) => {
          if (count)
            app.log.info({ recovered: count }, 'Recovered expired generations');
        })
        .catch(() => {
          app.log.warn(
            { category: 'STORAGE_UNAVAILABLE' },
            'Generation recovery unavailable',
          );
        })
        .finally(() => {
          recovery = undefined;
        });
    };
    const timer = setInterval(recover, 30000);
    timer.unref();
    app.addHook('onListen', async () => {
      recover();
    });
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await recovery;
      await database.$disconnect();
    });
  }
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try {
      await app.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      process.stderr.write(
        'Backend shutdown did not complete cleanly. Pending work remains recoverable.\n',
      );
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  await app.listen({ port: config.PORT, host: config.HOST });
}

start().catch((error: unknown) => {
  // Do not print arbitrary error objects; they may embed configuration values.
  process.stderr.write(
    error instanceof ConfigurationError
      ? `${error.message}\n`
      : 'Backend startup failed. Check port availability; see backend/.env.example.\n',
  );
  process.exitCode = 1;
});
