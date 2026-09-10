import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { RoyaltyStatementService } from "./statement-service.js";
import { DomainError } from "../core/errors.js";

interface Options {
  conditionStatus?: string;
  documentStatus?: string;
  agConsumed?: number;
  hasStatement?: boolean;
  partyKind?: string;
  withholding?: boolean;
  mg?: number | null;
  ag?: number | null;
  /** 対象日に効いていた版。null を渡すと「見つからない」を再現する。 */
  appliedVersion?: Record<string, unknown> | null;
}

const responder = (options: Options = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) {
    return [{ id: 6, status: options.documentStatus ?? "issued" }];
  }
  if (text.includes("FROM statements WHERE document_id")) {
    return options.hasStatement ? [{ id: 99 }] : [];
  }
  if (text.includes("FROM conditions c") && text.includes("LEFT JOIN parties p")) {
    return [{ id: 5, condition_no: "CL-2026-00042", name: "配信許諾", kind: "license",
              direction: "out", counterparty_id: 11, currency: "JPY",
              pricing_model: "revenue_rate", rate_ppm: 125000,
              unit_amount: null, flat_amount: null,
              mg_amount: options.mg ?? null, ag_amount: options.ag ?? null,
              tax_category: "taxable", status: options.conditionStatus ?? "active",
              agreement_title: "配信許諾基本契約", agreement_no: "AG-2026-0001",
              withholding: options.withholding ?? false,
              party_kind: options.partyKind ?? "corporate" }];
  }
  if (text.includes("SUM(e.deductions)")) return [{ consumed: options.agConsumed ?? 0 }];
  // 対象日に効いていた版の解決。既定では渡された版がそのまま返る。
  if (text.includes("c.status IN ('active', 'scheduled', 'superseded')")) {
    return options.appliedVersion === null ? []
      : [options.appliedVersion ?? { id: 5, condition_no: "CL-2026-00042", effective_from: null }];
  }
  if (text.includes("INSERT INTO condition_events")) return [{ id: 700 }];
  if (text.includes("INSERT INTO statements")) return [{ id: 800 }];
  return undefined;
};

const service = (options: Options = {}) => {
  const db = new FakeDatabase(responder(options));
  return { db, service: new RoyaltyStatementService(db) };
};

test("試算は書き込まない", async () => {
  const { db, service: royalty } = service();
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.fee.gross_ex_tax, 612000, "489.6万 × 12.5% = 61.2万");
  assert.equal(result.amounts.netMinor, 612000);
  assert.equal(db.all("INSERT").length, 0, "INSERT は1つも走らない");
});

test("確定は実績・計算書・明細を1トランザクションで書く", async () => {
  const { db, service: royalty } = service({ ag: 800000 });
  const result = await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2026上期",
    reported: { salesInput: 4896000 }
  }, "kuramochi");

  assert.equal(result.statementId, 800);
  assert.equal(result.eventId, 700);

  const event = db.find("INSERT INTO condition_events");
  assert.equal(event!.params[8], 612000 - 612000, "AGで全額相殺され実額はゼロ");
  assert.equal(event!.params[7], 612000, "相殺額を deductions に積む（次回の消化済み累計になる）");

  const statement = db.find("INSERT INTO statements");
  assert.equal(statement!.params[6], 612000, "ag_offset");
  assert.ok(db.find("INSERT INTO statement_lines"));
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "royalty.finalize");
  assert.ok(db.texts.includes("COMMIT"));
});

test("確定時はフォームの値を使わず計算し直す（消化済みAGを読む）", async () => {
  const { db, service: royalty } = service({ ag: 800000, agConsumed: 500000 });
  await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2026下期", reported: { salesInput: 4896000 }
  }, "kuramochi");

  assert.ok(db.find("SUM(e.deductions)"), "消化済みAGをDBから読む");
  const event = db.find("INSERT INTO condition_events");
  // AG残 30万 → 相殺30万、実額 61.2万 − 30万 = 31.2万
  assert.equal(event!.params[7], 300000);
  assert.equal(event!.params[8], 312000);
});

test("MGは下限として効き、消化されない", async () => {
  const { db, service: royalty } = service({ mg: 1200000 });
  const preview = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4000000 }
  });
  assert.equal(preview.fee.actual_ex_tax, 1200000);
  assert.equal(preview.amounts.mgTopupMinor, 700000);
  assert.equal(preview.amounts.agOffsetMinor, 0);
  void db;
});

test("相手先が個人なら源泉を自動で対象にする", async () => {
  const { service: royalty } = service({ partyKind: "individual" });
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.payment.withholdingEnabled, true);
  // 税抜 612,000 + 消費税 61,200 = 673,200 → 源泉 floor(673200 × 10.21%)
  assert.equal(result.payment.taxIncluded, 673200);
  assert.equal(result.payment.withholdingTax, Math.floor(673200 * 0.1021));
  assert.equal(result.payment.netTransfer, 673200 - Math.floor(673200 * 0.1021));
});

test("法人で源泉フラグが無ければ源泉は引かない", async () => {
  const { service: royalty } = service({ partyKind: "corporate" });
  const result = await royalty.preview({
    conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }
  });
  assert.equal(result.payment.withholdingEnabled, false);
  assert.equal(result.payment.withholdingTax, 0);
});

test("発行済みでない文書には計算書を結び付けない", async () => {
  const { db, service: royalty } = service({ documentStatus: "draft" });
  await assert.rejects(
    () => royalty.finalize({ conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 1 } }, "x"),
    (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  assert.ok(db.texts.includes("ROLLBACK"));
});

test("同じ文書に同じ条件の計算書は二重に作らない", async () => {
  const { service: royalty } = service({ hasStatement: true });
  await assert.rejects(
    () => royalty.finalize({ conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 1 } }, "x"),
    (e: unknown) => e instanceof DomainError && /計算書がすでにあります/.test(e.message));
});

test("束ね：1枚の文書に、条件ごとの計算書を作る", async () => {
  // 作品ひとつに取引モデルが何本もあるとき、相手先に出す計算書は1枚。
  // 計算は条件ごと（料率も MG・AG も条件ごとに違う）、計算書の行も条件ごと。
  const written = new Set<string>();
  const db = new FakeDatabase((text: string, params: unknown[]) => {
    if (text.includes("FROM documents WHERE id = $1 FOR UPDATE")) return [{ id: 6, status: "issued" }];
    if (text.includes("FROM statements WHERE document_id")) {
      return written.has(`${params[0]}/${params[1]}`) ? [{ id: 99 }] : [];
    }
    if (text.includes("FROM conditions c") && text.includes("LEFT JOIN parties p")) {
      const id = Number(params[0]);
      return [{ id, condition_no: `CL-2026-0004${id}`, name: `条件${id}`, kind: "license",
                direction: "out", counterparty_id: 11, currency: "JPY", pricing_model: "revenue_rate",
                rate_ppm: id === 5 ? 125000 : 200000,
                unit_amount: null, flat_amount: null, mg_amount: null, ag_amount: null,
                tax_category: "taxable", status: "active",
                agreement_title: "配信許諾基本契約", agreement_no: "AG-2026-0001",
                withholding: false, party_kind: "corporate" }];
    }
    if (text.includes("SUM(e.deductions)")) return [{ consumed: 0 }];
    if (text.includes("c.status IN ('active', 'scheduled', 'superseded')")) {
      return [{ id: Number(params[0]), condition_no: null, effective_from: null }];
    }
    if (text.includes("INSERT INTO condition_events")) return [{ id: 700 }];
    if (text.includes("INSERT INTO statements")) {
      written.add(`${params[0]}/${params[1]}`);
      return [{ id: 800 }];
    }
    return undefined;
  });
  const royalty = new RoyaltyStatementService(db);

  const done = await royalty.finalizeAll([
    { conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 4896000 } },
    { conditionId: 9, documentId: 6, period: "2026上期", reported: { salesInput: 1000000 } }
  ], "x");
  assert.equal(done.length, 2);
  assert.deepEqual(done.map((d) => d.netMinor), [612000, 200000], "条件ごとの料率で計算する");
  assert.equal(db.all("INSERT INTO statements").length, 2, "条件ごとに1本");
  assert.equal(db.all("FROM documents WHERE id = $1 FOR UPDATE").length, 1, "文書の錠は1回");

  // 同じ条件をもう一度は断る。二重に計上すると支払が倍になる。
  await assert.rejects(
    () => royalty.finalizeAll(
      [{ conditionId: 5, documentId: 6, period: "2026下期", reported: { salesInput: 1 } }], "x"),
    (e: unknown) => e instanceof DomainError && /計算書がすでにあります/.test(e.message));
});

test("束ね：文書がばらばらなら断る", async () => {
  const { service: royalty } = service();
  await assert.rejects(
    () => royalty.finalizeAll([
      { conditionId: 5, documentId: 6, period: "2026上期", reported: { salesInput: 1 } },
      { conditionId: 5, documentId: 7, period: "2026上期", reported: { salesInput: 1 } }
    ], "x"),
    (e: unknown) => e instanceof DomainError && /1枚の文書/.test(e.message));
});

test("無効・旧版の条件では計算しない", async () => {
  for (const status of ["void", "superseded"]) {
    const { service: royalty } = service({ conditionStatus: status });
    await assert.rejects(
      () => royalty.preview({ conditionId: 5, period: "2026上期", reported: { salesInput: 1 } }),
      (e: unknown) => e instanceof DomainError && e.code === "CONFLICT");
  }
});

// ---- 契約変更の適用開始日 ----

test("AGの消化累計は改訂の系列で数える（版が変わっても残高は戻らない）", async () => {
  const { db, service: royalty } = service({ ag: 1000000, agConsumed: 600000 });
  await royalty.preview({ conditionId: 5, period: "試算", reported: { salesInput: 4896000 } });
  const q = db.find("SUM(e.deductions)")!;
  assert.match(q.text, /c\.series_id = \(SELECT series_id FROM conditions WHERE id = \$1\)/,
    "1版ぶんだけ数えると、改訂のたびに前払保証の残高が満額に戻る");
});

test("対象日に効いていた版で計算する", async () => {
  const { db, service: royalty } = service();
  await royalty.preview({
    conditionId: 5, period: "2027Q1", occurredOn: "2027-02-15",
    reported: { salesInput: 1000000 }
  });
  const q = db.find("c.status IN ('active', 'scheduled', 'superseded')")!;
  assert.equal(q.params[1], "2027-02-15", "発生日をそのまま対象日に使う");
  assert.match(q.text, /effective_from IS NULL OR c\.effective_from <= COALESCE/);
  assert.match(q.text, /ORDER BY c\.effective_from DESC/, "その日以前で最も新しい版を採る");
});

test("渡した版と違う版で計算したときは、それを結果に載せる", async () => {
  const { service: royalty } = service({
    appliedVersion: { id: 9, condition_no: "CL-2026-00042-R2", effective_from: "2027-04-01" }
  });
  const r = await royalty.preview({
    conditionId: 5, period: "2027Q2", occurredOn: "2027-05-01",
    reported: { salesInput: 1000000 }
  });
  assert.equal(r.appliedVersion?.switched, true, "黙って差し替えず、画面で読めるようにする");
  assert.equal(r.appliedVersion?.effectiveFrom, "2027-04-01");
});

test("版が同じなら switched は立たない", async () => {
  const { service: royalty } = service();
  const r = await royalty.preview({ conditionId: 5, period: "試算", reported: { salesInput: 1 } });
  assert.equal(r.appliedVersion?.switched, false);
});

test("実績と計算書は、計算に使った版にぶら下げる", async () => {
  const { db, service: royalty } = service({
    appliedVersion: { id: 9, condition_no: "CL-2026-00042-R2", effective_from: "2027-04-01" }
  });
  await royalty.finalize({
    conditionId: 5, documentId: 6, period: "2027Q2", occurredOn: "2027-05-01",
    reported: { salesInput: 1000000 }
  }, "kuramochi");
  assert.equal(db.find("INSERT INTO condition_events")!.params[0], 9,
    "料率と実績の版が食い違うと、あとから検算できない");
  assert.equal(db.find("INSERT INTO statements")!.params[1], 9);
});

/** 実績の束から出す。売上報告が2件、報告売上は 300万 と 200万。 */
const eventRows = (over: Array<Partial<Record<string, unknown>>> = []) => [
  { id: 41, condition_id: 5, event_type: "sales", occurred_on: "2026-04-30", period: "2026上期",
    quantity: null, sample_quantity: null, gross_amount: 3000000, amount: 3000000,
    document_id: null, status: "active", note: null, same_series: true },
  { id: 42, condition_id: 5, event_type: "sales", occurred_on: "2026-06-30", period: "2026上期",
    quantity: null, sample_quantity: null, gross_amount: 2000000, amount: 2000000,
    document_id: null, status: "active", note: null, same_series: true }
].map((r, i) => ({ ...r, ...(over[i] ?? {}) }));

const withEvents = (rows: Array<Record<string, unknown>>, options: Options = {}) => {
  const base = responder(options);
  const db = new FakeDatabase((text, params) => {
    if (text.includes("FROM condition_events e JOIN conditions c") && text.includes("e.id = ANY")) {
      const ids = (params[0] as number[]).map(Number);
      return rows.filter((r) => ids.includes(Number(r.id)));
    }
    return base(text);
  });
  return { db, service: new RoyaltyStatementService(db) };
};

test("実績の束：報告売上を合算して1回計算し、期間は実績から導く", async () => {
  const { db, service: royalty } = withEvents(eventRows());
  const r = await royalty.preview({ conditionId: 5, eventIds: [41, 42] });
  assert.equal(r.reported.salesInput, 5000000, "300万 + 200万");
  assert.equal(r.period, "2026上期", "揃っているのでその期間");
  assert.equal(r.occurredOn, "2026-06-30", "発生日は最新");
  assert.equal(r.fee.gross_ex_tax, 625000, "500万 × 12.5%");
  assert.deepEqual(r.events.map((e) => e.share), [0.6, 0.4]);
  assert.equal(db.all("INSERT").length, 0);
});

test("実績の束：期間が揃っていなければ最古〜最新", async () => {
  const { service: royalty } = withEvents(eventRows([{ period: "2026-04" }, { period: "2026-06" }]));
  const r = await royalty.preview({ conditionId: 5, eventIds: [41, 42] });
  assert.equal(r.period, "2026-04-30〜2026-06-30");
});

test("実績の束：他の条件・取消済み・文書に結ばれた実績・違う種類は断る", async () => {
  const other = withEvents(eventRows([{ same_series: false }]));
  await assert.rejects(() => other.service.preview({ conditionId: 5, eventIds: [41, 42] }), /この条件の実績ではありません/);
  const voided = withEvents(eventRows([{ status: "void" }]));
  await assert.rejects(() => voided.service.preview({ conditionId: 5, eventIds: [41, 42] }), /取り消されています/);
  const taken = withEvents(eventRows([{}, { document_id: 9 }]));
  await assert.rejects(() => taken.service.preview({ conditionId: 5, eventIds: [41, 42] }), /別の文書に結ばれています/);
  const mixed = withEvents(eventRows([{ event_type: "manufacturing", quantity: 100 }]));
  await assert.rejects(() => mixed.service.preview({ conditionId: 5, eventIds: [41, 42] }), /売上 と 再許諾の受領 の実績だけ/);
});

test("実績の束の確定：実績は作らず、明細を実績ごとに根拠比で按分し、実績を文書に結ぶ", async () => {
  const { db, service: royalty } = withEvents(eventRows());
  const r = await royalty.finalize({ conditionId: 5, eventIds: [41, 42], documentId: 6 }, "kuramochi");
  assert.equal(db.all("INSERT INTO condition_events").length, 0, "新しい実績は作らない");
  const lines = db.all("INSERT INTO statement_lines");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].params[3], 41);
  assert.equal(lines[0].params[10], 375000, "62.5万 × 0.6");
  assert.equal(lines[1].params[10], 250000, "残り。合計は 62.5万");
  const linked = db.all("UPDATE condition_events SET document_id");
  assert.deepEqual(linked.map((q) => q.params), [[41, 6, 0], [42, 6, 0]],
    "実績ごとに文書へ結び、AG の消化（この条件は AG 無しなので 0）を積む");
  assert.equal(r.eventId, 41);
  const audit = db.find("INSERT INTO audit_events")!;
  assert.match(String(audit.params[5]), /"eventIds":\[41,42\]/);
});

test("実績の束の確定：AG の消化を実績に積む（次の計算書で二重に相殺しない）", async () => {
  // deductions 列が AG の消化累計。束ねる道で積んでいなかったので、
  // 前払保証がいつまでも消化されず、次の期も同じ額が相殺されていた。
  // 総額 62.5万・AG 80万。今回の充当は総額どまりの 62.5万。
  const { db, service: royalty } = withEvents(eventRows(), { ag: 800000 });
  const r = await royalty.finalize({ conditionId: 5, eventIds: [41, 42], documentId: 6 }, "kuramochi");
  assert.equal(r.netMinor, 0, "全額が AG で相殺されるので実額は出ない");
  const linked = db.all("UPDATE condition_events SET document_id");
  assert.deepEqual(linked.map((q) => q.params[2]), [375000, 250000], "根拠の比で割る");
  assert.equal(linked.reduce((sum, q) => sum + Number(q.params[2]), 0), 625000,
    "合計は今回の充当額と一致する");
});

test("按分は端数を最終行に寄せて、合計が総額と一致する", async () => {
  const { apportion } = await import("./statement-service.js");
  assert.deepEqual(apportion(100, [1 / 3, 1 / 3, 1 / 3]), [33, 33, 34]);
  assert.deepEqual(apportion(625000, [0.6, 0.4]), [375000, 250000]);
  assert.deepEqual(apportion(0, [1]), [0]);
});

test("実績を渡さないときは期間が必須（今までどおり実績を1件作る）", async () => {
  const { db, service: royalty } = service();
  await assert.rejects(() => royalty.preview({ conditionId: 5, reported: { salesInput: 1 } }), /対象期間を入れてください/);
  await royalty.finalize({ conditionId: 5, period: "2026上期", reported: { salesInput: 4896000 }, documentId: 6 }, "k");
  assert.equal(db.all("INSERT INTO condition_events").length, 1);
});
