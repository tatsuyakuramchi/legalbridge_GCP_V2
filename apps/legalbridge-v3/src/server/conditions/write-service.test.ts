import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { ConditionWriteService, PUB_DIGITAL_PAYMENT_TERMS, PUB_PRINT_PAYMENT_TERMS, periodicLines } from "./write-service.js";
import { DomainError } from "../core/errors.js";

const baseRows = (
  over: { status?: string; events?: number; pending?: Array<Record<string, unknown>> } = {}
) =>
  (text: string): Array<Record<string, unknown>> | undefined => {
    if (text.includes("FROM conditions WHERE id = $1 FOR UPDATE")) {
      return [{ id: 1, condition_no: "CL-2026-00042", status: over.status ?? "active",
                counterparty_id: 3, currency: "JPY", series_id: 1, effective_from: "2026-04-01" }];
    }
    if (text.includes("FROM parties WHERE id = $1")) return [{ id: 9, name: "新しい取引先" }];
    if (text.includes("count(*)::int AS n FROM condition_events")) return [{ n: over.events ?? 0 }];
    if (text.includes("SELECT current_date AS d")) return [{ d: "2026-09-08" }];
    if (text.includes("status = 'scheduled' AND id <> $2")) return over.pending ?? [];
    if (text.includes("UPDATE condition_schedules s")) return [];
    if (text.includes("AS documents")) {
      return [{ documents: 3, payments: 1, matters: 1, children: 0 }];
    }
    if (text.includes("INSERT INTO conditions")) return [{ id: 77 }];
    if (text.includes("UPDATE conditions")) return [{ id: 1 }];
    return undefined;
  };

test("相手先の変更は1行だけ書き、参照で追随するものを別建てで返す", async () => {
  const db = new FakeDatabase(baseRows());
  const result = await new ConditionWriteService(db).changeCounterparty(1, 9, "tester");

  const updates = db.all("UPDATE conditions SET counterparty_id");
  assert.equal(updates.length, 1, "書込は1文だけ");
  assert.deepEqual(result.changed, [{ target: "conditions.counterparty_id", rows: 1 }]);
  // 文書・支払・案件は書き換えていない
  assert.equal(db.all("UPDATE documents").length, 0);
  assert.equal(db.all("UPDATE payments").length, 0);
  assert.deepEqual(result.resolvesThrough.map((r) => r.target), [
    "この条件を出力した文書", "この条件に割り当てた支払", "この条件を参照する案件"
  ]);
  assert.ok(db.find("INSERT INTO audit_events"), "監査記録を残す");
  assert.ok(db.texts.includes("COMMIT"), "コミットする");
});

test("実績が無い条件は、金額をその場で書き換えられる（V2 に無かった経路）", async () => {
  const db = new FakeDatabase(baseRows({ events: 0 }));
  const result = await new ConditionWriteService(db)
    .updateEconomics(1, { mgAmount: 1500000, ratePpm: 150000 }, "tester");

  const update = db.find("UPDATE conditions SET mg_amount");
  assert.ok(update, "その場で更新する");
  assert.deepEqual(update!.params, [1, 1500000, 150000]);
  assert.equal(result.revisedTo, undefined);
  assert.equal(db.all("INSERT INTO conditions").length, 0, "改訂行は作らない");
});

test("通貨は、実績も支払も付いていなければその場で変えられる", async () => {
  const base = baseRows({ events: 0 });
  const db = new FakeDatabase((text) => {
    if (text.includes("AS events") && text.includes("AS payments")) return [{ events: 0, payments: 0 }];
    return base(text);
  });
  await new ConditionWriteService(db).updateEconomics(1, { currency: "USD" }, "tester");
  const update = db.find("UPDATE conditions SET currency");
  assert.ok(update, "その場で更新する");
  assert.deepEqual(update!.params, [1, "USD"]);
});

test("通貨は、実績か支払が付いていると変えられない（記録済みの金額が別の通貨として読まれる）", async () => {
  const base = baseRows({ events: 2 });
  const db = new FakeDatabase((text) => {
    if (text.includes("AS events") && text.includes("AS payments")) return [{ events: 2, payments: 1 }];
    return base(text);
  });
  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, { currency: "USD" }, "tester"),
    (e: unknown) => e instanceof DomainError && /通貨は変えられません/.test(e.message));
  assert.equal(db.all("INSERT INTO conditions").length, 0, "改訂にもしない");
});

test("実績がある条件は改訂になり、旧版は superseded として残る", async () => {
  const db = new FakeDatabase(baseRows({ events: 2 }));
  const result = await new ConditionWriteService(db)
    .updateEconomics(1, { mgAmount: 1500000 }, "tester");

  assert.equal(result.revisedTo, 77);
  assert.ok(db.find("INSERT INTO conditions"), "新版を作る");
  const supersede = db.find("SET status = 'superseded'");
  assert.ok(supersede, "旧版を superseded にする");
  assert.deepEqual(supersede!.params, [1, 77]);
  assert.ok(db.find("INSERT INTO condition_scopes"), "範囲も引き継ぐ");
  // 案件の紐づけは新版へ移す。旧版に残ると、案件から見える条件が古い版で止まる。
  const carry = db.find("INSERT INTO matter_links")!;
  assert.deepEqual(carry.params, ["1", "77"]);
  assert.deepEqual(db.find("DELETE FROM matter_links WHERE target_type = 'condition'")!.params, ["1"]);
  const audit = db.find("INSERT INTO audit_events");
  assert.ok(String(audit!.params[1]).includes("revise"));
});

test("旧版と無効の条件は編集を受け付けない", async () => {
  for (const status of ["superseded", "void"]) {
    const db = new FakeDatabase(baseRows({ status }));
    await assert.rejects(
      () => new ConditionWriteService(db).updateEconomics(1, { mgAmount: 1 }, "tester"),
      (error: unknown) => error instanceof DomainError && error.code === "CONFLICT"
    );
    assert.ok(db.texts.includes("ROLLBACK"), "失敗したらロールバックする");
  }
});

test("変更する項目が空なら弾く", async () => {
  const db = new FakeDatabase(baseRows());
  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, {}, "tester"),
    (error: unknown) => error instanceof DomainError && error.code === "VALIDATION"
  );
});

test("範囲の置き換えは削除してから入れ直す", async () => {
  const db = new FakeDatabase(baseRows());
  const result = await new ConditionWriteService(db).replaceScopes(1, [
    { scopeType: "region", label: "台湾", code: "TW" },
    { scopeType: "region", label: "  ", code: null },
    { scopeType: "language", label: "繁体字中国語", code: null }
  ], "tester");

  assert.ok(db.find("DELETE FROM condition_scopes"));
  assert.equal(db.all("INSERT INTO condition_scopes").length, 2, "空ラベルは捨てる");
  assert.equal(result.changed[0].target, "condition_scopes");
});

test("権限不足（42501）は機能縮退できる形の DomainError に変換する", async () => {
  const db = new FakeDatabase(() => { throw Object.assign(new Error("denied"), { code: "42501" }); });
  await assert.rejects(
    () => new ConditionWriteService(db).changeCounterparty(1, 9, "tester"),
    (error: unknown) => error instanceof DomainError && error.code === "DB_FORBIDDEN"
  );
});

// ---- 契約変更の適用開始日 ----

const FUTURE = "2027-04-01";

test("未来の適用開始日を渡すと、いまの版は生きたまま予約の版ができる", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  const r = await new ConditionWriteService(db)
    .updateEconomics(1, { ratePpm: 150000 }, "tester", FUTURE);

  const insert = db.find("INSERT INTO conditions")!;
  assert.match(insert.text, /'scheduled'|\$\d+ FROM conditions/, "新版を挿す");
  assert.ok(insert.params.includes("scheduled"), "予約の版として置く");
  assert.ok(insert.params.includes(FUTURE), "適用開始日を持たせる");
  // 旧版は superseded にしない。active が2行あると集計が二重になるので
  // 新版のほうを scheduled にして避ける。
  assert.equal(db.find("SET status = 'superseded'"), undefined,
    "適用日が来るまで、いまの版が効いたままでなければならない");
  assert.equal(r.revisedTo, 77);
});

test("適用開始日が今日以前なら、これまでどおり即座に切り替わる", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester", "2026-01-01");
  assert.ok(db.find("SET status = 'superseded'"), "旧版はその場で差し替え済みになる");
});

test("適用開始日を省いても、新版は今日から適用として記録する", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester");
  const insert = db.find("INSERT INTO conditions")!;
  assert.match(insert.text, /current_date/,
    "JS の時計ではなく SQL の current_date（時差で1日ずれる）");
});

test("予約は系列に1つだけ。二重に入れさせない", async () => {
  const db = new FakeDatabase(baseRows({
    events: 3, pending: [{ id: 55, condition_no: "CL-R2", effective_from: "2027-01-01" }] }));
  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester", FUTURE),
    /すでに 2027-01-01 適用の改訂が予定されています/);
  assert.equal(db.find("INSERT INTO conditions"), undefined);
});

test("予約そのものを直すときは、版を増やさず上書きする", async () => {
  const db = new FakeDatabase(baseRows({ status: "scheduled", events: 0 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 160000 }, "tester", FUTURE);
  assert.equal(db.find("INSERT INTO conditions"), undefined, "まだ効いていないので版は増やさない");
  const update = db.find("UPDATE conditions SET")!;
  assert.ok(update.params.includes(FUTURE));
});

test("改訂は予定明細を新版へ引き継ぐ（写さずに移す）", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { flatAmount: 300000 }, "tester", FUTURE);
  const carry = db.find("UPDATE condition_schedules s")!;
  assert.ok(carry, "引き継がないと、12回分の予定が改訂で消える");
  assert.match(carry.text, /SET condition_id = \$2/, "両方の版に残すと予定の合計が二重になる");
  assert.match(carry.text, /due_on >= \$3::date/, "適用日より前の回は旧版のまま");
  assert.match(carry.text, /NOT EXISTS \(SELECT 1 FROM condition_events/,
    "実績が付いた回は動かさない");
});

test("改訂は系列を引き継ぐ", async () => {
  const db = new FakeDatabase(baseRows({ events: 3 }));
  await new ConditionWriteService(db).updateEconomics(1, { ratePpm: 150000 }, "tester");
  assert.match(db.find("INSERT INTO conditions")!.text, /series_id/,
    "系列が切れると AG の消化累計が版ごとに分かれる");
});

test("作品と独占性も編集で直せる。無い作品は断る", async () => {
  const rows = baseRows({ events: 0 });
  const db: FakeDatabase = new FakeDatabase((t, params) => {
    if (t.includes("SELECT id FROM works WHERE id")) return params[0] === 9 ? [{ id: 9 }] : [];
    return rows(t);
  });
  await new ConditionWriteService(db).updateEconomics(1, { workId: 9, exclusivity: "exclusive" }, "tester");
  const update = db.find("UPDATE conditions SET work_id");
  assert.ok(update, "登録と同じ項目を編集でも受ける");
  assert.deepEqual(update!.params, [1, 9, "exclusive"]);

  await assert.rejects(
    () => new ConditionWriteService(db).updateEconomics(1, { workId: 404 }, "tester"), /作品 404 が見つかりません/);
});

// ---- 無効化 → 削除 -----------------------------------------------------

const deleteRows = (
  over: { status?: string; blockers?: Record<string, number> } = {}
) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM conditions WHERE id = $1 FOR UPDATE")) {
    return [{ id: 1, condition_no: "CL-2026-00042", status: over.status ?? "active",
              counterparty_id: 3, currency: "JPY", series_id: 1, effective_from: null }];
  }
  if (text.includes("AS older_versions")) {
    return [{ events: 0, out_refs: 0, documents: 0, payments: 0, statements: 0,
              statement_lines: 0, matters: 0, children: 0, older_versions: 0, ...over.blockers }];
  }
  if (text.includes("AS documents")) return [{ documents: 0, payments: 0, matters: 0, children: 0 }];
  if (text.includes("UPDATE conditions")) return [{ id: 1 }];
  return undefined;
};

test("無効化は行を残し、理由を備考に足す", async () => {
  const db = new FakeDatabase(deleteRows());
  const result = await new ConditionWriteService(db).void(1, "登録ミス", "tester");
  const update = db.find("SET status = 'void'");
  assert.ok(update, "状態を変えるだけで消さない");
  assert.deepEqual(update!.params, [1, "無効化：登録ミス"]);
  assert.equal(db.all("DELETE FROM conditions").length, 0);
  assert.deepEqual(result.changed, [{ target: "conditions（無効化）", rows: 1 }]);
  const audit = db.find("INSERT INTO audit_events");
  assert.equal(audit!.params[1], "condition.void");
});

test("理由なしでは無効化できない", async () => {
  const db = new FakeDatabase(deleteRows());
  await assert.rejects(() => new ConditionWriteService(db).void(1, " ", "t"), /理由は必須/);
});

test("旧版と無効化済みは無効化できない", async () => {
  await assert.rejects(
    () => new ConditionWriteService(new FakeDatabase(deleteRows({ status: "superseded" }))).void(1, "x", "t"),
    /最新版を無効化/);
  await assert.rejects(
    () => new ConditionWriteService(new FakeDatabase(deleteRows({ status: "void" }))).void(1, "x", "t"),
    /すでに無効化/);
});

test("削除は無効化済みで、何も指していないものだけ", async () => {
  // 2段階。いきなり消せる作りにすると押し間違いが取り返せない。
  const active = new FakeDatabase(deleteRows({ status: "active" }));
  await assert.rejects(() => new ConditionWriteService(active).remove(1, "t"), /先に無効化/);
  assert.equal(active.all("DELETE FROM conditions").length, 0);

  const voided = new FakeDatabase(deleteRows({ status: "void" }));
  const result = await new ConditionWriteService(voided).remove(1, "t");
  assert.deepEqual(result, { deleted: true, conditionNo: "CL-2026-00042" });
  assert.ok(voided.find("DELETE FROM conditions WHERE id = $1"));
  assert.equal(voided.find("INSERT INTO audit_events")!.params[1], "condition.delete");
});

test("指しているものがあれば消さず、何が指しているかを言う", async () => {
  // 取り消した実績も数える。取り消しの記録がこの条件を指している。
  const db = new FakeDatabase(deleteRows({
    status: "void", blockers: { events: 2, documents: 1, out_refs: 1, older_versions: 1 }
  }));
  await assert.rejects(() => new ConditionWriteService(db).remove(1, "t"), (e: DomainError) => {
    assert.match(e.message, /実績 2 件/);
    assert.match(e.message, /文書 1 件/);
    assert.match(e.message, /アウト条件にした実績 1 件/);
    assert.match(e.message, /改訂された旧版 1 件/);
    return true;
  });
  assert.equal(db.all("DELETE FROM conditions").length, 0);
});

test("定期課金も金額が要る。空だと毎月の額を持たない条件ができる", async () => {
  // flat_amount を「1回あたり」として読むので、ここが空だと計算が 0 になる。
  // 画面も定期課金のとき金額欄を出していなかったので、素通りしていた。
  const db = new FakeDatabase(() => []);
  await assert.rejects(
    () => new ConditionWriteService(db).create({
      name: "月次保守", direction: "in", kind: "service",
      counterpartyId: 1, currency: "JPY", pricingModel: "subscription"
    }, "k"),
    /1回あたりの金額を入れてください/);
});

test("許諾セット：定額の行は flat_amount・計算方式 fixed で、再許諾の可否と計算書の時期を束で持つ", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT title FROM works")) return [{ title: "作品A" }];
    if (t.includes("FROM parties WHERE id = $1")) return [{ id: 3, name: "権利元" }];
    if (t.includes("FROM works WHERE id")) return [{ id: 5, title: "作品A" }];
    if (t.includes("current_value")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO conditions")) return [{ id: 1, condition_no: "CL-1" }];
    return [];
  });
  const svc = new ConditionWriteService(db);
  await svc.createLicenseSet({
    counterpartyId: 3, workId: 5, sublicensable: true, sublicenseConsentDefault: "covered", statementTiming: "periodic",
    paymentTerms: "計算書送付後30日以内",
    rows: [{ usageType: "in_house", ratePct: 0, pricingModel: "fixed", flatAmount: 500000 },
           { usageType: "sublicense", ratePct: 8 }]
  }, "a");
  const inserts = db.all("INSERT INTO conditions");
  assert.equal(inserts.length, 2);
  const fixed = inserts[0].params, rate = inserts[1].params;
  assert.equal(fixed[15], "fixed"); assert.equal(fixed[18], 500000); assert.equal(fixed[16], null);
  assert.equal(rate[15], "revenue_rate"); assert.equal(rate[16], 80000);
  assert.equal(fixed[9], true, "sublicensable");
  assert.equal(fixed[10], "covered", "sublicense_consent の既定");
  assert.equal(fixed[36], "periodic", "statement_timing");
  assert.equal(fixed[22], "計算書送付後30日以内");
  await assert.rejects(() => svc.createLicenseSet({ counterpartyId: 3, workId: 5,
    rows: [{ usageType: "in_house", ratePct: 0, pricingModel: "fixed", flatAmount: null }] }, "a"), /定額の金額/);
});

test("業務委託の明細：1 行＝条件 1 本。行の納期・契約形式・帰属・単位が条件に入り、受注者帰属なら利用許諾条件も立つ", async () => {
  const db: FakeDatabase = new FakeDatabase((t, params) => {
    if (t.includes("FROM parties WHERE id = $1")) return [{ id: 3, name: "ブエノデザイン" }];
    if (t.includes("SELECT title FROM works")) return [{ title: "J-TAG" }];
    if (t.includes("FROM works WHERE id")) return [{ id: 5, title: "J-TAG" }];
    if (t.includes("current_value")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO conditions")) return [{ id: 10 + db.all("INSERT INTO conditions").length, condition_no: "CL-x" }];
    if (t.includes("usage_type = $3 AND status IN")) return [];
    return [];
  });
  const svc = new ConditionWriteService(db);
  const r = await svc.createServiceSet({
    title: "J-TAG Web サイト制作", counterpartyId: 3, workId: 5, contractForm: "請負", deliverableOwnership: "orderer",
    paymentTerms: "検収後 月末締め翌月末払い",
    rows: [
      { kind: "service", name: "TOP デザイン", pricingModel: "unit_rate", unitAmount: 150000, quantity: 1, unitLabel: "式", deliveryDue: "2026-11-14" },
      { kind: "service", name: "A1 パネル", pricingModel: "unit_rate", unitAmount: 70000, quantity: 1, unitLabel: "式",
        deliveryDue: "2026-12-05", contractForm: "準委任", deliverableOwnership: "contractor" },
      { kind: "expense", name: "交通費", pricingModel: "fixed", flatAmount: 5000 }
    ],
    license: { mode: "included", usageType: "in_house" },
    payment: { mode: "per_delivery" }
  }, "a");
  const inserts = db.all("INSERT INTO conditions");
  assert.equal(inserts.length, 4, "委託料 2 本＋実費 1 本＋利用許諾 1 本");
  const [top, panel, expense, license] = inserts.map((q) => q.params);
  assert.equal(top[4], "TOP デザイン"); assert.equal(top[13], "2026-11-14", "納期は行ごと（delivery_due）");
  assert.equal(top[37], "式", "単位");
  assert.equal(panel[29], "準委任", "行の契約形式が既定に勝つ"); assert.equal(panel[26], "contractor");
  assert.equal(expense[21], "exempt", "実費は非課税");
  assert.equal(license[3], "license"); assert.equal(license[4], "J-TAG｜自社製造・自社販売");
  assert.equal(license[34], "included", "許諾料は委託報酬に含む");
  assert.equal(license[15], "none", "含むなら計算なし");
  assert.equal(r.licenseConditions.length, 1); assert.equal(r.licenseConditions[0].existed, false);
});

test("業務委託の明細：行ごとに作品を持てる。受注者帰属なら作品ごとに利用許諾条件が立つ（同じ作品は 1 本）", async () => {
  const titles: Record<number, string> = { 5: "J-TAG", 7: "K-POP" };
  const db: FakeDatabase = new FakeDatabase((t, params) => {
    if (t.includes("FROM parties WHERE id = $1")) return [{ id: 3, name: "ブエノデザイン" }];
    if (t.includes("SELECT title FROM works")) return [{ title: titles[Number(params?.[0])] }];
    if (t.includes("FROM works WHERE id")) return [{ id: Number(params?.[0]) }];
    if (t.includes("current_value")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO conditions")) return [{ id: 10 + db.all("INSERT INTO conditions").length, condition_no: "CL-x" }];
    if (t.includes("usage_type = $3 AND status IN")) return Number(params?.[0]) === 7 ? [{ id: 99, condition_no: "CL-99" }] : [];
    return [];
  });
  const r = await new ConditionWriteService(db).createServiceSet({
    title: "素材制作", counterpartyId: 3, workId: 5, deliverableOwnership: "contractor",
    rows: [
      { kind: "service", name: "J-TAG ロゴ", flatAmount: 100 },
      { kind: "service", name: "K-POP ロゴ", flatAmount: 200, workId: 7 },
      { kind: "service", name: "社内資料", flatAmount: 300, workId: null, deliverableOwnership: "orderer" },
      { kind: "service", name: "J-TAG バナー", flatAmount: 400, workId: 5 }
    ],
    license: { mode: "free", usageType: "in_house" }
  }, "a");
  const inserts = db.all("INSERT INTO conditions").map((q) => q.params);
  assert.deepEqual(inserts.slice(0, 4).map((p) => p[6]), [5, 7, null, 5], "行の作品（未指定は上の作品、null は作品なし）");
  assert.equal(inserts.length, 5, "委託料 4 本＋J-TAG の利用許諾 1 本（K-POP は既にある）");
  assert.equal(inserts[4][6], 5);
  assert.deepEqual(r.licenseConditions.map((c) => [c.id, c.existed]), [[15, false], [99, true]]);
});

test("業務委託の明細：委託料の行が複数なら品目名が要る。受注者帰属で作品が無ければ止める", async () => {
  const svc = new ConditionWriteService(new FakeDatabase(() => []));
  await assert.rejects(() => svc.createServiceSet({ title: "x", counterpartyId: 3,
    rows: [{ kind: "service", flatAmount: 1 }, { kind: "service", flatAmount: 2 }] }, "a"), /行ごとに品目名/);
  await assert.rejects(() => svc.createServiceSet({ title: "x", counterpartyId: 3, deliverableOwnership: "contractor",
    rows: [{ kind: "service", flatAmount: 1 }], license: { mode: "included" } }, "a"), /作品が要ります/);
  await assert.rejects(() => svc.createServiceSet({ title: "x", counterpartyId: 3, workId: 5, deliverableOwnership: "contractor",
    rows: [{ kind: "service", flatAmount: 1 }], license: { mode: "separate" } }, "a"), /料率か定額/);
});

test("定期払いの予定明細：from〜to を every か月ごとに 1 回、期の末日が発生日", () => {
  const lines = periodicLines("2026-11-01", "2027-01-31", 1, 20000, "サーバー管理");
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => [l.serviceFrom, l.serviceTo, l.dueOn]),
    [["2026-11-01", "2026-11-30", "2026-11-30"], ["2026-12-01", "2026-12-31", "2026-12-31"], ["2027-01-01", "2027-01-31", "2027-01-31"]]);
  assert.equal(lines[0].triggerKind, "periodic"); assert.equal(lines[0].plannedAmount, 20000);
  assert.equal(lines[0].label, "サーバー管理 2026-11");
  assert.equal(periodicLines("2027-01-01", "2026-01-01", 1, 1, "x").length, 0);
});

// ---- 共著の取り分（A-068 / A-070）----

const shareRows = (over: { counterparty?: number; mg?: number | null } = {}) => (text: string): Array<Record<string, unknown>> | undefined => {
  if (text.includes("FROM conditions WHERE id = $1 FOR UPDATE")) {
    return [{ id: 1, condition_no: "CL-1", status: "active", counterparty_id: over.counterparty ?? 21, currency: "JPY", series_id: 1, effective_from: null }];
  }
  if (text.includes("SELECT condition_no, direction, kind, pricing_model, mg_amount, ag_amount, work_id FROM conditions")) {
    return [{ condition_no: "CL-1", direction: "in", kind: "license", pricing_model: "revenue_rate",
              mg_amount: over.mg ?? null, ag_amount: null, work_id: 7 }];
  }
  if (text.includes("c.work_id = $2 AND c.id <> $1")) return [{ id: 2, condition_no: "CL-2" }];
  if (text.includes("SELECT id FROM parties WHERE id = ANY")) return [{ id: 21 }, { id: 22 }];
  if (text.includes("AS documents")) return [{ documents: 0, payments: 0, matters: 0, children: 0 }];
  return undefined;
};

test("取り分の置き換え：行を入れ直し、分配を誰がするかを条件に書く", async () => {
  const db = new FakeDatabase(shareRows());
  const r = await new ConditionWriteService(db).replaceShares(1,
    [{ partyId: 21, sharePpm: 666667 }, { partyId: 22, sharePpm: 333333 }], "tester");
  assert.equal(db.all("INSERT INTO condition_shares").length, 2);
  assert.deepEqual(db.find("UPDATE conditions SET distribution")!.params, [1, "direct"], "空は direct");
  assert.equal(r.changed[0].target, "condition_shares");

  // 同じ作品の紙・電子にも入れる。
  const db3 = new FakeDatabase(shareRows());
  const r3 = await new ConditionWriteService(db3).replaceShares(1,
    [{ partyId: 21, sharePpm: 666667 }, { partyId: 22, sharePpm: 333333 }], "tester", null, { applyToWork: true });
  assert.equal(db3.all("INSERT INTO condition_shares").length, 4, "2 本 × 2 行");
  assert.deepEqual(r3.changed.map((c) => c.target), ["condition_shares", "condition_shares:CL-2"]);

  // 取り分を外すと distribution も空に戻る。
  const db2 = new FakeDatabase(shareRows());
  await new ConditionWriteService(db2).replaceShares(1, [], "tester");
  assert.deepEqual(db2.find("UPDATE conditions SET distribution")!.params, [1, null]);
});

test("代表が分配する契約：相手先が取り分に無ければ断る。MG があってもよい", async () => {
  await assert.rejects(
    () => new ConditionWriteService(new FakeDatabase(shareRows({ counterparty: 99 }))).replaceShares(1,
      [{ partyId: 21, sharePpm: 500000 }, { partyId: 22, sharePpm: 500000 }], "tester", "representative"),
    (e: unknown) => e instanceof DomainError && /相手先（代表）を取り分の中に/.test(e.message));
  const db = new FakeDatabase(shareRows({ mg: 100000 }));
  await new ConditionWriteService(db).replaceShares(1,
    [{ partyId: 21, sharePpm: 500000 }, { partyId: 22, sharePpm: 500000 }], "tester", "representative");
  assert.deepEqual(db.find("UPDATE conditions SET distribution")!.params, [1, "representative"]);
  // 当社が分配するときは MG のある条件に付けられない。
  await assert.rejects(
    () => new ConditionWriteService(new FakeDatabase(shareRows({ mg: 100000 }))).replaceShares(1,
      [{ partyId: 21, sharePpm: 500000 }, { partyId: 22, sharePpm: 500000 }], "tester"),
    (e: unknown) => e instanceof DomainError && /MG・AG/.test(e.message));
});

test("出版セット：支払条件が空なら媒体ごとの既定（紙は刷部数確定の都度、電子は年 1 回の集計）。書いてあればそれ", async () => {
  const mk = () => new FakeDatabase((t) => {
    if (t.includes("SELECT title FROM works")) return [{ title: "作品A" }];
    if (t.includes("FROM parties WHERE id = $1")) return [{ id: 3, name: "権利元" }];
    if (t.includes("FROM works WHERE id")) return [{ id: 5, title: "作品A" }];
    if (t.includes("current_value")) return [{ current_value: 1 }];
    if (t.includes("INSERT INTO conditions")) return [{ id: 1, condition_no: "CL-1" }];
    return [];
  });
  const empty = mk();
  await new ConditionWriteService(empty).createPublishingSet({
    counterpartyId: 3, workId: 5, print: { ratePct: 10, exclusivity: null }, digital: { ratePct: 15, exclusivity: null }
  }, "a");
  const [print, digital] = empty.all("INSERT INTO conditions").map((q) => q.params);
  assert.equal(print[22], PUB_PRINT_PAYMENT_TERMS);
  assert.equal(digital[22], PUB_DIGITAL_PAYMENT_TERMS);
  assert.equal(PUB_PRINT_PAYMENT_TERMS, "都度払い（刊行日を含む月の翌月末日払い）");
  assert.equal(PUB_DIGITAL_PAYMENT_TERMS, "毎年7月1日〜翌年6月30日を集計期間とし、10月末日までに支払う。");

  const given = mk();
  await new ConditionWriteService(given).createPublishingSet({
    counterpartyId: 3, workId: 5, paymentTerms: "月末締め翌月末払い", print: { ratePct: 10, exclusivity: null }, digital: { ratePct: 15, exclusivity: null }
  }, "a");
  assert.deepEqual(given.all("INSERT INTO conditions").map((q) => q.params[22]), ["月末締め翌月末払い", "月末締め翌月末払い"]);
});
