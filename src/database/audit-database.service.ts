import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class AuditDatabaseService implements OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.AUDIT_DATABASE_URL || undefined,
    host: process.env.AUDIT_DB_HOST,
    port: Number(process.env.AUDIT_DB_PORT ?? 5432),
    database: process.env.AUDIT_DB_NAME ?? 'audit_anchor',
    user: process.env.AUDIT_DB_USER ?? 'postgres',
    password: process.env.AUDIT_DB_PASSWORD,
    max: Number(process.env.AUDIT_DATABASE_POOL_MAX ?? 10),
    ssl: process.env.AUDIT_DB_SSL_MODE === 'require'
      ? { rejectUnauthorized: process.env.AUDIT_DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : undefined,
  });

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, [...values]);
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T | null> {
    const result = await this.query<T>(text, values);
    return result.rows[0] ?? null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
