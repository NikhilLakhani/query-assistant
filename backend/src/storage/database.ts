import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Transaction = Prisma.TransactionClient;
export type Database = PrismaClient;

export function createDatabase(connectionString: string): Database {
  const adapter = new PrismaPg({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    options:
      '-c lock_timeout=3000 -c statement_timeout=5000 -c idle_in_transaction_session_timeout=5000',
  });
  // Do not enable Prisma query/error event logging: parameters can contain chats
  // and password hashes. Errors are translated at the application boundary.
  return new PrismaClient({ adapter, log: [] });
}

/** All ledger mutations use the same row lock, in short DB-only transactions. */
export async function withLedgerLock<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "LedgerLock" WHERE "id" = 'global' FOR UPDATE`;
      if (rows.length !== 1) throw new Error('Ledger migration is missing');
      return work(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 5_000,
    },
  );
}

export async function databaseIsReady(db: Database): Promise<boolean> {
  try {
    // A table/data marker check also catches an empty or unmigrated database.
    return Boolean(await db.ledgerLock.findUnique({ where: { id: 'global' } }));
  } catch {
    return false;
  }
}
