import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Generation/validation need no connection; migration commands require this URL.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
