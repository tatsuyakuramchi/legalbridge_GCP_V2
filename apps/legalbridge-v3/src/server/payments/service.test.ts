import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { PaymentService } from "./service.js";
import { DomainError } from "../core/errors.js";

interface Options {
  direction?: "in" | "out";      // 条件の向き
  partyKind?: string;
  withholding?: boolean;
  occurredOn?: string;
  duplicated?: boolean;
  noParty?: boolean;
  /** 1枚に何本の計算書が載っているか。上書きしたい列だけ書く。 */
  statements?: Array<Record<string, unknown>>;
  /** 紙に出る支払期日（予定の回の支払日）。 */
  schedulePayOn?: string;
  /** その計算書に載っている実績。前金・後金で2件になる。 */
  events?: Array<{ id: number; condition_id: number; amount: number; occurred_on?: string }>;
  /** 紙に印字した支払期日（焼き付けた値）。 */
  printedDueOn?: string | null;
  /** 条件明細の支払条件（「月末締め翌月末払い」）。 */
  paymentTerms?: string | null;
}

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM statements s")) {
    return (options.statements ?? [{}]).map((over, i) => ({
      statement_id: 800 + i, condition_id: 5 + i * 4,
      currency: "JPY", net_amount: 612000, tax_amount: 61200,
              period: "2026上期", direction: options.direction ?? "in",
              tax_category: "taxable", counterparty_id: options.noParty ? null : 2,
              party_kind: options.partyKind ?? "individual", withholding: options.withholding ?? false,
              party_name: "如月 涼", event_id: 700 + i,
              occurred_on: options.occurredOn ?? "2026-06-20",
              payment_terms: options.paymentTerms ?? null,
              schedule_pay_on: options.schedulePayOn ?? null, ...over }));
  }
  if (text.includes("FROM documents d WHERE d.id = $1")) {
    return [{ due_on: options.printedDueOn ?? null }];
  }
  if (text.includes("FROM condition_events ev")) return options.events ?? [];
  if (text.includes("JOIN payment_allocations a ON a.payment_id = p.id")) {
    return options.duplicated ? [{ id: 55 }] : [];
  }
  if (text.includes("INSERT INTO payments")) return [{ id: 900 }];
  if (text.includes("UPDATE payments")) return [{ id: 900, due_on: "2026-08-19", basis_received_on: "2026-06-20" }];
  return undefined;
};

const svc = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  return { db, service: new PaymentService(db) };
};

test("計算書から支払を起こし、必ず条件と実績に割り当てる", async () => {
  const { db, service } = svc();
  const result = await service.createFromStatementDocument(26, "kuramochi");

  assert.equal(result.paymentId, 900);
  assert.equal(result.direction, "out", "取得（IN）条件なので自社が支払う");
  const allocation = db.find("INSERT INTO payment_allocations");
  assert.deepEqual(allocation!.params, [900, 5, 700, 612000]);
  assert.ok(db.texts.includes("COMMIT"));
});

test("束ねた計算書は、1枚につき1件の支払にまとめる", async () => {
  // 条件ごとに支払を立てると、相手先に1枚しか出していないのに支払が何件も並び、
  // 経理提出用の表も行がばらける。支払は文書1枚につき1件、割当は条件ごと。
  const { db, service } = svc({
    statements: [
      {},
      { net_amount: 57600, tax_amount: 5760, occurred_on: "2026-07-31" }
    ]
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");

  assert.equal(db.all("INSERT INTO payments").length, 1, "支払は1件");
  assert.equal(result.amount, 612000 + 57600, "条件ごとの実額を足す");
  assert.equal(result.tax, 61200 + 5760, "消費税も条件ごとの額を足す");
  const allocations = db.all("INSERT INTO payment_allocations");
  assert.deepEqual(allocations.map((a) => a.params),
    [[900, 5, 700, 612000], [900, 9, 701, 57600]], "割当は条件ごと");
  assert.equal(result.dueOn, "2026-09-29", "起算日はいちばん遅い実績（2026-07-31）の +60日");
});

test("支払期日は受領日 +60日を既定にする", async () => {
  const { service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-19");
  assert.equal(result.due.verdict, "ok");
  assert.equal(result.due.days, 60);
});

test("期日を61日以降にすると超過として記録に残る", async () => {
  const { db, service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi", { dueOn: "2026-08-27" });
  assert.equal(result.due.verdict, "over_limit");
  assert.equal(result.due.overBy, 8);
  const issue = db.find("PAYMENT_DUE_OVER_LIMIT");
  assert.ok(issue, "データ品質の記録に残す");
});

test("個人への支払は源泉を引く", async () => {
  const { service } = svc({ partyKind: "individual" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  // 税抜 612,000 + 消費税 61,200 = 673,200 → floor(× 10.21%)
  assert.equal(result.withholding, Math.floor(673200 * 0.1021));
});

test("受け取る側（許諾）では源泉を引かない", async () => {
  const { service } = svc({ direction: "out", partyKind: "individual" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.direction, "in", "許諾（OUT）条件なので入金");
  assert.equal(result.withholding, 0);
});

test("同じ実績に二重の支払は作らない", async () => {
  const { db, service } = svc({ duplicated: true });
  await assert.rejects(() => service.createFromStatementDocument(26, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT" && /#55/.test(e.message));
  assert.equal(db.all("INSERT INTO payments").length, 0);
});

test("相手先が未設定の条件からは支払を作らない", async () => {
  const { service } = svc({ noParty: true });
  await assert.rejects(() => service.createFromStatementDocument(26, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "VALIDATION");
});

test("支払を記録すると期日超過の記録が閉じる", async () => {
  const { db, service } = svc();
  await service.markPaid(900, "2026-08-15", "kuramochi");
  const resolved = db.find("SET status = 'resolved'");
  assert.ok(resolved, "期日超過の記録を閉じる");
  assert.deepEqual(resolved!.params, [900]);
});

test("期日は紙に出した支払期日（予定の回）と同じにする", async () => {
  // 計算書は予定の支払日を {{paymentDueDate}} として印字している。支払だけ
  // 60日 の上限で立てていたので、相手に送った紙が 09-18、社内の支払が 10-30
  // という食い違いが出ていた。検収書の経路は予定の支払日を見ている。
  const { service } = svc({ occurredOn: "2026-08-31", schedulePayOn: "2026-09-18" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-09-18", "60日後（2026-10-30）ではなく紙の日");
});

test("回をまたぐときは、いちばん遅い支払日を使う", async () => {
  const { service } = svc({
    occurredOn: "2026-08-31",
    statements: [
      { schedule_pay_on: "2026-09-18" },
      { net_amount: 57600, tax_amount: 5760, schedule_pay_on: "2026-10-20" }
    ]
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-10-20", "早いほうに合わせると、遅い回が期日前になる");
});

test("予定の支払日が60日を超えていても、黙って上限へ丸めない", async () => {
  // 上限は法の線であって約束の日ではない。約束した日で立て、超過は記録に残す。
  const { db, service } = svc({ occurredOn: "2026-06-20", schedulePayOn: "2026-08-27" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-27");
  assert.equal(result.due.verdict, "over_limit");
  assert.equal(result.due.overBy, 8);
  assert.ok(db.find("PAYMENT_DUE_OVER_LIMIT"), "データ品質の記録に残す");
});

test("予定の回が無ければ、これまでどおり受領日 +60日", async () => {
  const { service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-19");
});

test("前金・後金の計算書は、実績ごとに割り当てる", async () => {
  // いちばん新しい実績1件だけに全額を割り当てていた。紙は2行なのに経理提出用は
  // 合計の1行になり、割り当てられなかったほうの実績には支払済みの印が付かない。
  // 同じ実績で二度目の支払を立てても、重複の検査に引っかからない。
  const { db, service } = svc({
    events: [
      { id: 700, condition_id: 5, amount: 73680 },
      { id: 701, condition_id: 5, amount: 53261 }
    ],
    statements: [{ net_amount: 126941, tax_amount: 12694 }]
  });
  await service.createFromStatementDocument(26, "kuramochi");
  const allocations = db.all("INSERT INTO payment_allocations").map((a) => a.params);
  assert.equal(allocations.length, 2, "実績の数だけ割当を作る");
  assert.deepEqual(allocations, [[900, 5, 700, 73680], [900, 5, 701, 53261]]);
  assert.equal(allocations.reduce((sum, a) => sum + Number(a[3]), 0), 126941,
    "割当の合計は支払の額と一致する");
});

test("MG・AG で総額がずれても、割当の合計は支払の額に合わせる", async () => {
  // 実績の額の比で割る。按分してから丸めると合計が1円ずれる。
  const { db, service } = svc({
    events: [
      { id: 700, condition_id: 5, amount: 10000 },
      { id: 701, condition_id: 5, amount: 20000 }
    ],
    statements: [{ net_amount: 100001, tax_amount: 10000 }]
  });
  await service.createFromStatementDocument(26, "kuramochi");
  const amounts = db.all("INSERT INTO payment_allocations").map((a) => Number(a.params[3]));
  assert.equal(amounts.reduce((a, b) => a + b, 0), 100001, "端数は最後の1本に寄せる");
  assert.deepEqual(amounts, [33334, 66667]);
});

test("実績が1件の計算書は、これまでどおり1件の割当", async () => {
  const { db, service } = svc({ events: [{ id: 700, condition_id: 5, amount: 612000 }] });
  await service.createFromStatementDocument(26, "kuramochi");
  assert.deepEqual(db.all("INSERT INTO payment_allocations").map((a) => a.params),
    [[900, 5, 700, 612000]]);
});

// ---- 取り消し ---------------------------------------------------------

const cancelSvc = (row: Record<string, unknown> | null) => {
  const db = new FakeDatabase((text: string) => {
    if (text.includes("FROM payments WHERE id = $1 FOR UPDATE")) return row ? [row] : [];
    return undefined;
  });
  return { db, service: new PaymentService(db) };
};

const planned = { id: 900, payment_no: "PAY-2026-0007", status: "planned",
                  amount: 126941, paid_on: null, note: null };

test("支払を取り消すと、行は残り理由が付く", async () => {
  // 支払は「いつ・誰に・いくら払う約束をしたか」の記録。消すと約束をした
  // 事実まで消える。文書の無効化・実績の取り消しと同じ扱いにする。
  const { db, service } = cancelSvc(planned);
  const result = await service.cancel(900, "期日と明細が違うので立て直す", "kuramochi");
  assert.deepEqual(result, { paymentId: 900, canceled: true });
  const update = db.find("UPDATE payments SET status = 'canceled'");
  assert.ok(update, "行は消さずに状態を変える");
  assert.equal(update!.params[1], "取消：期日と明細が違うので立て直す");
  const audit = db.find("INSERT INTO audit_events");
  assert.ok(audit, "監査記録に残す");
  assert.equal(audit!.params[1], "payment.cancel");
});

test("理由なしでは取り消せない", async () => {
  const { service } = cancelSvc(planned);
  await assert.rejects(() => service.cancel(900, "   ", "k"), /理由は必須/);
});

test("すでに取り消したものは二度取り消さない", async () => {
  const { service } = cancelSvc({ ...planned, status: "canceled" });
  await assert.rejects(() => service.cancel(900, "重複", "k"), /すでに取り消されています/);
});

test("支払済みは取り消せない。返金は別の記録にする", async () => {
  // お金が出たあとで約束だけ無かったことにすると、帳簿と現金が合わなくなる。
  const { service } = cancelSvc({ ...planned, status: "paid", paid_on: "2026-09-18" });
  await assert.rejects(() => service.cancel(900, "やり直し", "k"), /支払済みです/);
});

test("無い支払は取り消せない", async () => {
  const { service } = cancelSvc(null);
  await assert.rejects(() => service.cancel(900, "x", "k"), DomainError);
});

test("期日は紙に印字した日をいちばんに見る", async () => {
  // 期日を決めるものが3つある。紙の支払期日は文書作成フォームで人が入れられる
  // ので、予定明細だけを見ていると、印字した日と支払の日が食い違う。
  const { service } = svc({
    occurredOn: "2026-08-31", printedDueOn: "2026-09-18", schedulePayOn: "2026-10-05"
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-09-18", "予定明細（10-05）より紙が勝つ");
});

test("紙の日付が読めない形なら、予定明細へ落ちる", async () => {
  // 和暦や「未定」が入っていることがある。日付として読めないものは使わない。
  const { service } = svc({
    occurredOn: "2026-08-31", printedDueOn: "令和8年9月18日", schedulePayOn: "2026-10-05"
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-10-05");
});

test("紙にも予定にも無ければ、受領日 +60日", async () => {
  const { service } = svc({ occurredOn: "2026-06-20" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-19");
});

// ---- 条件宛てに手で立てる（案件の画面から） ----------------------------------

const manualSvc = (over: { condition?: Record<string, unknown> | null; partyKind?: string } = {}) => {
  const db = new FakeDatabase((text: string) => {
    if (text.includes("FROM conditions WHERE id = $1")) {
      return over.condition === null ? [] : [over.condition ?? {
        id: 5, condition_no: "CL-2026-00005", counterparty_id: 2, currency: "JPY", direction: "in", status: "active"
      }];
    }
    if (text.includes("FROM parties WHERE id")) return [{ id: 2, name: "如月 涼", kind: over.partyKind ?? "corporate" }];
    if (text.includes("SELECT 1 FROM document_sequences")) return [{ x: 1 }];
    if (text.includes("UPDATE document_sequences")) return [{ current_value: 7 }];
    if (text.includes("FROM payments WHERE payment_no")) return [];
    if (text.includes("INSERT INTO payments")) return [{ id: 901, payment_no: "PAY-2026-00007" }];
    return undefined;
  });
  return { db, service: new PaymentService(db) };
};

test("条件宛てに立てた支払は、相手先・通貨・向きを条件から取り、全額をその条件に割り当てる", async () => {
  const { db, service } = manualSvc();
  const r = await service.create({ conditionId: 5, amount: 30000, taxAmount: 3000, dueOn: "2026-10-31" }, "k");
  assert.equal(r.id, 901);
  assert.equal(r.direction, "out", "取得（IN）の条件なので自社が払う");
  assert.equal(r.conditionId, 5);
  const inserted = db.find("INSERT INTO payments")!;
  assert.deepEqual(inserted.params.slice(1, 5), ["out", 2, "JPY", 30000]);
  assert.deepEqual(db.find("INSERT INTO payment_allocations")!.params, [901, 5, null, 30000]);
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(JSON.parse(String(audit.params[5])).conditionNo, "CL-2026-00005");
});

test("条件も相手先も無い、条件の相手先と違う、旧版の条件には立てない", async () => {
  await assert.rejects(() => manualSvc().service.create({ amount: 1 }, "k"), /相手先か、割り当てる条件/);
  await assert.rejects(() => manualSvc().service.create({ conditionId: 5, partyId: 9, amount: 1 }, "k"), /条件の相手先と違います/);
  await assert.rejects(() => manualSvc({ condition: { id: 5, condition_no: "CL-1", counterparty_id: 2, currency: "JPY",
    direction: "in", status: "superseded" } }).service.create({ conditionId: 5, amount: 1 }, "k"), /改訂済み/);
  await assert.rejects(() => manualSvc({ condition: null }).service.create({ conditionId: 5, amount: 1 }, "k"), /見つかりません/);
});

test("相手先だけの支払はこれまでどおり割当なしで立つ", async () => {
  const { db, service } = manualSvc();
  const r = await service.create({ partyId: 2, direction: "out", amount: 500 }, "k");
  assert.equal(r.id, 901);
  assert.equal(db.all("INSERT INTO payment_allocations").length, 0);
});

/**
 * 支払期日は条件明細の支払条件から出す（A-040）。
 *
 * 予定の回を立てずに実績から支払を起こすと、これまでは受領日 +60日に落ちて
 * いた。60日は下請法の上限であって約束の日ではないので、条件に書いてあれば
 * そちらを使う。紙・予定の回が先なのは変えない。
 */
test("予定の回が無ければ、条件の支払条件から期日を出す", async () => {
  const { service } = svc({ occurredOn: "2026-06-20", paymentTerms: "月末締め翌月末払い" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-07-31", "+60日（2026-08-19）ではなく翌月末");
});

test("支払条件どうしが違えば、いちばん遅い日（全部を満たす日）", async () => {
  const { service } = svc({
    occurredOn: "2026-06-20",
    statements: [
      { payment_terms: "月末締め翌月末払い" },
      { net_amount: 57600, tax_amount: 5760, payment_terms: "月末締め翌々月20日払い" }
    ]
  });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-20");
});

test("紙に出した日・予定の回のほうが先（支払条件で上書きしない）", async () => {
  const printed = await svc({ occurredOn: "2026-06-20", paymentTerms: "月末締め翌月末払い",
                              printedDueOn: "2026-07-15" })
    .service.createFromStatementDocument(26, "kuramochi");
  assert.equal(printed.dueOn, "2026-07-15", "紙が先");
  const scheduled = await svc({ occurredOn: "2026-06-20", paymentTerms: "月末締め翌月末払い",
                                schedulePayOn: "2026-07-20" })
    .service.createFromStatementDocument(26, "kuramochi");
  assert.equal(scheduled.dueOn, "2026-07-20", "予定の回が先");
});

test("読めない支払条件は使わない（60日の既定に落ちる）", async () => {
  // 「30日以内」は締め日が決まらないので日付に落とせない。黙って何かの日を
  // 作るより、これまでどおり上限を既定にして人に決めてもらう。
  const { service } = svc({ occurredOn: "2026-06-20", paymentTerms: "検収後30日以内" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-08-19");
});

/**
 * 検収書からの支払（業務委託）。納品・検収から起こすので、予定の回を立てて
 * いないことが多い。ここが受領日 +60日に落ちていた。
 */
const inspectionDb = (over: Record<string, unknown> = {}) => new FakeDatabase((text) => {
  if (text.includes("FROM condition_events e")) {
    return [{ event_id: 700, amount: 300000, occurred_on: "2026-06-20", inspected_on: "2026-06-25",
              deliverable: "挿絵 10点", condition_id: 5, direction: "in", tax_category: "taxable",
              currency: "JPY", counterparty_id: 2, payment_terms: null,
              party_kind: "individual", withholding: true, schedule_pay_on: null, ...over }];
  }
  if (text.includes("JOIN payment_allocations a ON a.payment_id = p.id")) return [];
  if (text.includes("INSERT INTO payments")) return [{ id: 901 }];
  if (text.includes("UPDATE payments")) {
    return [{ id: 901, due_on: "2026-08-24", basis_received_on: "2026-06-25" }];
  }
  return undefined;
});

test("検収書：予定の回が無ければ、条件の支払条件から期日を出す", async () => {
  const withTerms = await new PaymentService(inspectionDb({ payment_terms: "検収月の翌月末払い" }))
    .createFromInspection(31, "kuramochi");
  assert.equal(withTerms.dueOn, "2026-07-31", "検収日 2026-06-25 の翌月末");

  // 支払条件が無い条件は、これまでどおり受領日 +60日。
  const without = await new PaymentService(inspectionDb())
    .createFromInspection(31, "kuramochi");
  assert.equal(without.dueOn, "2026-08-24");
});

test("支払条件が日付そのものなら、その日を期日にする（V1・V2 から来た条件）", async () => {
  const { service } = svc({ occurredOn: "2026-06-20", paymentTerms: "2026-12-31" });
  const result = await service.createFromStatementDocument(26, "kuramochi");
  assert.equal(result.dueOn, "2026-12-31");
});

/**
 * 管理者が支払を直す（A-041）。日付と備考だけ。金額は割当の合計なので、
 * ここでは触らない（実績を直して立て直す）。
 */
const amendDb = (over: Record<string, unknown> = {}) => new FakeDatabase((text) => {
  if (text.includes("FROM payments p")) {
    return [{ id: 900, payment_no: "PY-2026-0009", status: "open", amount: 330000,
              direction: "out", due_on: "2026-08-19", basis_received_on: "2026-06-20",
              paid_on: null, note: null, party_kind: "individual", ...over }];
  }
  return [];
});

test("支払の修正：期日を直し、前後の値と理由を監査に残す", async () => {
  const db = amendDb();
  const r = await new PaymentService(db).amend(
    900, { dueOn: "2026-07-31" }, "条件の支払条件（翌月末）に合わせる", "admin");
  assert.deepEqual(r.changed, ["dueOn"]);
  const q = db.find("UPDATE payments SET")!;
  assert.match(q.text, /due_on = \$2::date/);
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "payment.amend");
  const detail = JSON.parse(String(audit.params[5]));
  assert.equal(detail.reason, "条件の支払条件（翌月末）に合わせる");
  assert.deepEqual(detail.before, { dueOn: "2026-08-19" });
  assert.deepEqual(detail.after, { dueOn: "2026-07-31" });
});

test("支払の修正：期日を直したら、期日超過の判定をやり直す", async () => {
  // 上限の外へ動かせば記録が open に、内側へ戻せば閉じる。
  const over = amendDb();
  const r = await new PaymentService(over).amend(900, { dueOn: "2026-09-30" }, "延期の合意", "admin");
  assert.equal(r.due?.verdict, "over_limit");
  assert.ok(over.find("PAYMENT_DUE_OVER_LIMIT"), "記録に残す");

  const back = amendDb({ due_on: "2026-09-30" });
  const fixed = await new PaymentService(back).amend(900, { dueOn: "2026-07-31" }, "戻す", "admin");
  assert.equal(fixed.due?.verdict, "ok");
  assert.match(back.find("PAYMENT_DUE_OVER_LIMIT")!.text, /SET status = 'resolved'/);
});

test("支払の修正：取り消した支払は直せない。理由は必須", async () => {
  await assert.rejects(
    () => new PaymentService(amendDb({ status: "canceled" }))
      .amend(900, { dueOn: "2026-07-31" }, "訂正", "admin"),
    /取り消した支払は直せません/);
  await assert.rejects(
    () => new PaymentService(amendDb()).amend(900, { dueOn: "2026-07-31" }, " ", "admin"),
    /修正の理由は必須です/);
});

test("支払の修正：支払済みの日は空にできない（取り消しは別の操作）", async () => {
  await assert.rejects(
    () => new PaymentService(amendDb({ status: "paid", paid_on: "2026-08-15" }))
      .amend(900, { paidOn: null }, "間違えた", "admin"),
    /支払済みの日は空にできません/);
});
