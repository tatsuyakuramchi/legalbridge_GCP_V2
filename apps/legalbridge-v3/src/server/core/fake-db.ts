import type { Queryable, Transactable } from "./db.js";

export interface RecordedQuery { text: string; params: unknown[] }
type Responder = (text: string, params: unknown[]) => Array<Record<string, unknown>> | undefined;

/**
 * テスト用の偽データベース。SQL の断片で応答を返し、実行された SQL を記録する。
 * 「何を書いたか」を検証するのが目的なので、SQL の意味は解釈しない。
 */
export class FakeDatabase implements Transactable {
  readonly queries: RecordedQuery[] = [];
  constructor(private readonly responder: Responder = () => undefined) {}

  async query(text: string, params: unknown[] = []) {
    this.queries.push({ text, params });
    const rows = this.responder(text, params) ?? [];
    return { rows, rowCount: rows.length };
  }

  async connect() {
    const self = this;
    return {
      query: (text: string, params?: unknown[]) => self.query(text, params ?? []),
      release() { /* noop */ }
    } satisfies Queryable & { release(): void };
  }

  /** 指定の断片を含む最初のクエリ。 */
  find(fragment: string): RecordedQuery | undefined {
    return this.queries.find((q) => q.text.includes(fragment));
  }
  all(fragment: string): RecordedQuery[] {
    return this.queries.filter((q) => q.text.includes(fragment));
  }
  get texts(): string[] { return this.queries.map((q) => q.text); }
}
