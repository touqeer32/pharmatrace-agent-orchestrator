import 'dotenv/config';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

async function migrationDirectory(): Promise<string> {
  const candidates = [
    join(__dirname, 'migrations'),
    join(process.cwd(), 'src', 'database', 'migrations'),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported development/production location.
    }
  }

  throw new Error('Could not locate the database migration directory');
}

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    );

    const directory = await migrationDirectory();
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

    for (const name of files) {
      const sql = await readFile(join(directory, name), 'utf8');
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('pharmatrace-agent-orchestrator:migrations'))",
        );
        const existing = await client.query(
          'SELECT 1 FROM schema_migrations WHERE name = $1',
          [name],
        );

        if (existing.rowCount) {
          await client.query('COMMIT');
          process.stdout.write(`Skipping applied migration ${name}\n`);
          continue;
        }

        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        process.stdout.write(`Applied migration ${name}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
