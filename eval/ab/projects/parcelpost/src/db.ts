import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}
