/**
 * 案件の旧分を畳むときの形。
 *
 * ここは何も読まない。画面がこの型を1つ借りるだけで、service 経由で PDF の
 * 書き出しまで引きずり込むのを避ける（settled-columns と同じ理由。実際に
 * client の型検査が node:child_process を読めずに落ちた）。
 */

export type Step = "payment" | "document" | "event" | "condition";

export interface TeardownInput {
  /** 畳む条件を絞る。空なら案件の条件すべて。 */
  conditionIds?: number[];
  /**
   * 書き出した CSV。「旧分」の列で、どの条件をどこまで畳むかを言える。
   * 13人ぶんを表計算で一目見ながら決められるので、画面のチェックより速い。
   * 渡されたら conditionIds と voidConditions より優先する。
   */
  csv?: string | null;
  /**
   * 条件まで無効にするか。既定は false（残す）。
   * true にすると入れ直しで新しい条件番号になる。
   */
  voidConditions?: boolean;
  reason: string;
}

export interface PlanPayment {
  id: number; paymentNo: string | null; amount: number;
  status: string; paidOn: string | null; blocked: string | null;
}

export interface PlanDocument {
  id: number; documentNo: string | null; templateLabel: string | null;
  settlement: boolean; status: string; blocked: string | null;
}

export interface PlanEvent {
  id: number; conditionId: number; conditionNo: string | null;
  occurredOn: string | null; amount: number; documentNo: string | null;
}

export interface PlanCondition {
  id: number; conditionNo: string | null; name: string; partyName: string | null;
}

export interface TeardownPlan {
  matter: { id: number; matterNo: string | null; title: string };
  payments: PlanPayment[];
  documents: PlanDocument[];
  events: PlanEvent[];
  /** 無効にする条件。CSV なら「無効」と書いた行のものだけ。 */
  conditions: PlanCondition[];
  voidConditions: boolean;
  /**
   * CSV の「旧分」で対象を決めたか。そのときは画面の「条件明細も無効にする」
   * は効かない（CSV の列が優先する）ので、画面はチェックを出さない。
   */
  fromCsv: boolean;
  summary: {
    payments: number; documents: number; events: number; conditions: number;
    blocked: number; amount: number;
  };
  /** 人に読んでほしいこと。押す前に出す。 */
  warnings: string[];
}

export interface TeardownOutcome {
  step: Step; id: number; label: string; ok: boolean; error: string | null;
}

export interface TeardownResult {
  ok: number; failed: number; skipped: number;
  outcomes: TeardownOutcome[];
}
