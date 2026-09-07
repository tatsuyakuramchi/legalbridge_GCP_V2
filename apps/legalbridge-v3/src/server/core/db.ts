// SQL を実行できる最小インターフェース。Pool でも PoolClient でも満たすため、
// リポジトリはトランザクションの内外を意識せず同じコードで書ける。
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface Transactable extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** BEGIN / COMMIT / ROLLBACK を1か所に閉じる。書込サービスは必ずこれを通す。 */
export async function inTransaction<T>(
  database: Transactable,
  run: (client: Queryable) => Promise<T>
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ROLLBACK 自体の失敗は握る */ }
    throw error;
  } finally {
    client.release();
  }
}

export const str = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v);
export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);
export const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};

/**
 * date 列の文字列化。node-postgres は date を JS の Date に変換するため、
 * String() すると "Fri Aug 28 2026 ..." になってしまう。
 * タイムゾーンでずれないよう、ローカルの年月日から組み立てる。
 */
export const dateStr = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};
