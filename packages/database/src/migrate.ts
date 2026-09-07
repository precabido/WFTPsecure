/**
 * Minimal forward-only migration runner.
 *
 * Deliberately not a framework: migrations are plain .sql files applied in
 * filename order inside a transaction, recorded in schema_migrations. A schema
 * this small does not need a dependency that would have to be audited as part
 * of a security-sensitive deployment.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(connectionString?: string): Promise<string[]> {
  const pool = getPool(connectionString);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

/** Drop and recreate the public schema. Test helper — never call in production. */
export async function resetSchema(connectionString?: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetSchema must never run in production');
  }
  const pool = getPool(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  migrate()
    .then(async (ran) => {
      console.log(ran.length === 0 ? 'no migrations to apply' : `applied: ${ran.join(', ')}`);
      await closePool();
    })
    .catch(async (error: Error) => {
      console.error('migration failed:', error.message);
      await closePool();
      process.exit(1);
    });
}
