import type { Queryable, Transactable } from "./db.js";

/**
 * 1 本の接続（外側のトランザクションの中）に、書込サービスを丸ごと乗せるための Transactable。
 *
 * 書込サービスは inTransaction（BEGIN / COMMIT / ROLLBACK）で自分のトランザクションを張る。
 * ここではそれを SAVEPOINT に読み替えるので、サービスに手を入れずに、いくつもの書込を
 * 外側の 1 トランザクションに収められる。外側を ROLLBACK すれば何も残らない
 * （まとめて直すの試算。conditions/bundle-service.ts preview）。
 */
export class PinnedDatabase implements Transactable {
  private seq = 0;
  constructor(private readonly client: Queryable) {}

  query(text: string, params?: unknown[]) { return this.client.query(text, params); }

  async connect(): Promise<Queryable & { release(): void }> {
    const name = `pinned_${++this.seq}`;
    const client = this.client;
    return {
      query: (text: string, params?: unknown[]) => {
        const head = text.trim().replace(/;$/, "").toUpperCase();
        if (head === "BEGIN") return client.query(`SAVEPOINT ${name}`);
        if (head === "COMMIT") return client.query(`RELEASE SAVEPOINT ${name}`);
        if (head === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return client.query(text, params);
      },
      release() { /* 外側の接続は呼び手が返す */ }
    };
  }
}
