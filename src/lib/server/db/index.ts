import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { env } from '$env/dynamic/private';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';

const dbPath = env.DATABASE_PATH || './data/cairn.db';
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
// Work-phase jobs write while page loads read; wait instead of failing SQLITE_BUSY.
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

migrate(db, { migrationsFolder: 'drizzle' });

export * from './schema';
