import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentIssueService } from "./issue-service.js";

const doc = (status: string, extra: Record<string, unknown> = {}) => ({
  id: 5, document_no: "ARC-PO-2026-0007", status,
  template_version_id: 2, matter_id: 3, agreement_id: null, manual_inputs: {}, ...extra
});

const build = (row: Record<string, unknown> | undefined) => new FakeDatabase((text) => {
  if (text.includes("FROM documents WHERE id")) return row ? [row] : [];
  if (text.includes("INSERT INTO documents")) return [{ id: 9 }];
  return undefined;
});

test("無効化しても行は消さない。status を変えて理由を残す", async () => {
  const db = build(doc("issued"));
  const r = await new DocumentIssueService(db).void(5, "宛先を間違えたため", "kuramochi");

  assert.equal(r.documentNo, "ARC-PO-2026-0007");
  assert.ok(!db.queries.some((q) => /DELETE\s+FROM\s+documents/i.test(q.text)),
    "発行した事実そのものが記録なので消さない");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "document.void");
  assert.match(JSON.stringify(audit.params), /宛先を間違えた/);
});

test("理由なしでは無効にできない", async () => {
  const svc = new DocumentIssueService(build(doc("issued")));
  await assert.rejects(() => svc.void(5, "   ", "k"), /理由を書いてください/);
});

test("すでに無効なものは二度無効にしない", async () => {
  const svc = new DocumentIssueService(build(doc("void")));
  await assert.rejects(() => svc.void(5, "重複", "k"), /すでに無効です/);
});

test("差し替え済みは無効にできない。新しい版を無効にする", async () => {
  const svc = new DocumentIssueService(build(doc("superseded")));
  await assert.rejects(() => svc.void(5, "取消", "k"), /新しい版を無効に/);
});

test("訂正版を作った時点では、元はまだ有効なまま", async () => {
  // 作るときに元を退かせると、下書きを捨てた瞬間に有効な版がゼロになる。
  // 退くのは訂正版を発行したとき。
  const db = build(doc("issued"));
  const r = await new DocumentIssueService(db).reissue(5, "金額を訂正するため", "kuramochi");

  assert.equal(r.id, 9);
  assert.equal(r.supersedesId, 5);
  const created = db.find("INSERT INTO documents")!;
  assert.equal(created.params[4], 5, "新版から旧版へ supersedes_id で繋ぐ");
  assert.equal(created.params[5], "金額を訂正するため", "理由を新しい版に持たせる");
  assert.ok(db.find("INSERT INTO document_conditions"), "紐づく条件を引き継ぐ");
  assert.ok(!db.queries.some((q) => q.text.includes("status = 'superseded'")),
    "作った時点では元を退かせない");
});

test("訂正版の下書きが開いているあいだは、もう1枚作らせない", async () => {
  // 溜めても発行できるのは1枚だけ（発行した時点で元が退く）。残りは
  // 行き場のない下書きとして一覧に積もる。
  const db = new FakeDatabase((text) => {
    if (text.includes("WHERE supersedes_id = $1 AND status = 'draft'")) return [{ id: 12 }];
    if (text.includes("FROM documents WHERE id")) return [doc("issued")];
    return undefined;
  });
  await assert.rejects(() => new DocumentIssueService(db).reissue(5, "再訂正", "k"),
    /もう訂正版の下書きがあります（#12）/);
  assert.ok(!db.find("INSERT INTO documents"), "2枚目は作らない");
});

test("下書きは作り直せない。まだ発行していない", async () => {
  const svc = new DocumentIssueService(build(doc("draft")));
  await assert.rejects(() => svc.reissue(5, "訂正", "k"), /発行済みの文書だけ/);
});

test("テンプレートの無い取込文書は作り直せない", async () => {
  const svc = new DocumentIssueService(build(doc("issued", { template_version_id: null })));
  await assert.rejects(() => svc.reissue(5, "訂正", "k"), /取込文書は作り直せません/);
});

test("存在しない文書には何もしない", async () => {
  const svc = new DocumentIssueService(build(undefined));
  await assert.rejects(() => svc.void(5, "x", "k"), /見つかりません/);
  await assert.rejects(() => svc.reissue(5, "x", "k"), /見つかりません/);
});

test("部分テンプレートは単独で発行できない", async () => {
  // terms_spot_2026 は発注書の末尾に差し込む約款。それ自体は書類ではないので、
  // 採番の話になる前に断る（V1 でも採番記号を持っていなかった）。
  const db = new FakeDatabase((text) => {
    if (text.includes("FROM documents WHERE id")) return [doc("draft")];
    if (text.includes("FROM document_template_versions tv")) {
      return [{ template_id: 1, version_id: 2, template_key: "terms_spot_2026",
                label: "terms_spot_2026", category: "partial", number_prefix: null,
                html_source: "<p>約款</p>", variables: [] }];
    }
    if (text.includes("FROM document_conditions")) return [];
    return undefined;
  });
  await assert.rejects(() => new DocumentIssueService(db).issue(5, "k"),
    /単独では発行できません/);
  assert.ok(!db.queries.some((q) => /document_sequences/i.test(q.text)),
    "採番まで進まない");
});

/** 訂正版を発行したときに、前の版が退いて実績が移るところ。 */
const issuing = (extra: Record<string, unknown> = {}, oldStatus = "issued") => {
  let seenOld = false;
  return new FakeDatabase((text) => {
    // 前の版の読み出しが先。どちらも "FROM documents WHERE id" を含むので、
    // 細かいほうから順に見る。
    if (text.includes("SELECT id, document_no, status FROM documents WHERE id")) {
      seenOld = true;
      return [{ id: 5, document_no: "ARC-INS-2026-1001", status: oldStatus }];
    }
    if (text.includes("FROM documents WHERE id")) {
      return [doc("draft", { supersedes_id: 5, supersede_reason: "金額を訂正するため", ...extra })];
    }
    if (text.includes("FROM document_template_versions tv")) {
      return [{ template_id: 1, version_id: 2, template_key: "inspection_certificate",
                label: "検収書", category: "inspection", number_prefix: "INS",
                html_source: "<p>{{X}}</p>", variables: [] }];
    }
    if (text.includes("FROM document_conditions")) return [];
    if (text.includes("INSERT INTO document_sequences")) return [{ current_value: 12 }];
    if (text.includes("UPDATE documents") && text.includes("status = 'issued'")) {
      return [{ issued_at: "2026-09-09T00:00:00Z" }];
    }
    if (text.includes("UPDATE condition_events SET document_id")) return [{ id: 41 }, { id: 42 }];
    if (text.includes("FROM document_templates t") && !seenOld) return [];
    return undefined;
  });
};

test("訂正版を発行すると、前の版が退いて実績も移る（差し替えは1手）", async () => {
  const db = issuing();
  const r = await new DocumentIssueService(db).issue(9, "kuramochi");
  assert.match(r.documentNo, /^ARC-INS-\d{4}-0012$/);

  const retired = db.queries.find((q) => q.text.includes("status = 'superseded'"))!;
  assert.equal(retired.params[0], 5, "前の版を退かせる");

  const moved = db.queries.find((q) => q.text.includes("UPDATE condition_events SET document_id"))!;
  assert.deepEqual(moved.params, [5, 9],
    "実績は前の版から新しい版へ移す。移さないと結び直しに前の版の無効化が要る");

  const audit = db.queries.filter((q) => q.text.includes("INSERT INTO audit_events"))
    .map((q) => q.params[1]);
  assert.ok(audit.includes("document.supersede"), "差し替えを記録に残す");
  assert.match(JSON.stringify(db.find("INSERT INTO audit_events")!.params), /金額を訂正するため/);
});

test("前の版がすでに無効なら、訂正版は普通に出る", async () => {
  const db = issuing({}, "void");
  await new DocumentIssueService(db).issue(9, "k");
  assert.ok(!db.queries.some((q) => q.text.includes("status = 'superseded'")),
    "退かせるものが無い");
});

test("差し替えでない下書きは、他の文書に触らない", async () => {
  const db = issuing({ supersedes_id: null, supersede_reason: null });
  await new DocumentIssueService(db).issue(9, "k");
  assert.ok(!db.queries.some((q) => q.text.includes("UPDATE condition_events SET document_id")),
    "関係のない実績を動かさない");
});

/** 下敷きにして次を作る。発注書から検収書を起こすときの形。 */
const deriving = (base: Record<string, unknown>) => new FakeDatabase((text) => {
  if (text.includes("LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id")) {
    return [base];
  }
  if (text.includes("FROM document_templates t JOIN document_template_versions tv")) {
    return [{ template_id: 7, version_id: 21, template_key: "inspection_certificate",
              label: "検収書", category: "inspection", number_prefix: "INS",
              html_source: "<p>{{X}}</p>", variables: [] }];
  }
  if (text.includes("INSERT INTO documents")) return [{ id: 9 }];
  return undefined;
});

test("下敷きにして次を作ると、前の文書は退かず、ひな形を変えた下書きができる", async () => {
  // 発注書（決定済み）から検収書を起こす。発注書はそのまま有効。
  const db = deriving({ ...doc("issued"), template_key: "purchase_order",
                        manual_inputs: { inspectorDept: "海外制作チーム" } });
  const r = await new DocumentIssueService(db)
    .derive(5, { templateKey: "inspection_certificate" }, "kuramochi");

  assert.equal(r.id, 9);
  assert.equal(r.baseId, 5);
  assert.equal(r.templateKey, "inspection_certificate");
  const created = db.find("INSERT INTO documents")!;
  assert.equal(created.params[0], 21, "選んだひな形の現行版で作る");
  assert.match(String(created.params[3]), /海外制作チーム/, "手入力を引き継ぐ");
  assert.ok(!created.text.includes("supersedes_id"), "訂正版ではないので前の版に繋がない");
  assert.ok(db.find("INSERT INTO document_conditions"), "条件明細を引き継ぐ");
  assert.ok(!db.queries.some((q) => q.text.includes("status = 'superseded'")),
    "前の文書は退かない");
  const audit = db.find("INSERT INTO audit_events")!;
  assert.equal(audit.params[1], "document.derive");
  assert.equal(JSON.parse(String(audit.params[5])).baseDocumentId, 5);
});

test("ひな形を指定しなければ、同じひな形のもう1枚になる", async () => {
  const db = deriving({ ...doc("issued"), template_key: "inspection_certificate" });
  const r = await new DocumentIssueService(db).derive(5, {}, "k");
  assert.equal(r.templateKey, "inspection_certificate");
});

test("無効にした文書は下敷きにできない。取込文書はひな形の指定が要る", async () => {
  await assert.rejects(
    () => new DocumentIssueService(deriving({ ...doc("void"), template_key: "purchase_order" }))
      .derive(5, {}, "k"),
    /無効にした文書は下敷きにできません/);
  await assert.rejects(
    () => new DocumentIssueService(deriving({ ...doc("issued", { template_version_id: null }),
                                              template_key: null }))
      .derive(5, {}, "k"),
    /ひな形を選んでください/);
});
