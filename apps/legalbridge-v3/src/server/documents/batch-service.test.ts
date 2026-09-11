import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DocumentBatchService, groupRows, ownershipOfRows, readRows, readTriggerKind,
         sameAcross, scheduleLinesFrom, templateCsv } from "./batch-service.js";

const HEAD = "取引先コード,取引先名,作品コード,作品名,契約番号,条件名,品目・業務名,仕様・成果物,数量,"
  + "単価（税抜）,起点,納期,支払日,契約種別・支払条件,成果物の帰属先,支払方法,備考";

/** 作品を書かない CSV。以前の運用そのまま（作品なしの委託）。 */
const CSV = `${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,第4巻 表紙イラスト,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,,第4巻 挿絵,モノクロ12点,12,"8,000",検収,2026/10/31,2026-11-30,,発注者（譲渡型）,,
,ヨシザワ アツオ,,,,,第4巻 地図イラスト,見開き1点,1,60000,納品後,2026-10-15,2026-11-30,,発注者,固定額,
VD-00120,株式会社ヒナタ翻訳,,,,,英訳,全章,1,200000,契約時,2026-12-20,2027-01-31,,発注者,業績連動,`;

/** 取引先2社 × 作品2本。同じ取引先でも作品が違えば別の発注書になる。 */
const CSV_WORKS = `${HEAD}
VD-00317,合同会社アトリエ蒼,WRK-10013,,,,表紙イラスト,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,WRK-10013,,,,挿絵,モノクロ4点,4,20000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,WRK-10021,,,,表紙イラスト,カラー1点,1,120000,契約時,2026-11-30,2026-12-31,,発注者,固定額,
,株式会社ヒナタ翻訳,,夜明けのクロニクル,,,翻訳,全章,1,60000,検収後,2026-11-15,2026-12-31,,発注者,固定額,`;

test("雛形の見出しは列の定義から出す（BOM 付き）。例は作品違いの2行", () => {
  const csv = templateCsv();
  assert.ok(csv.startsWith("﻿取引先コード,取引先名,作品コード,作品名,契約番号,条件名,品目・業務名"));
  assert.ok(csv.includes("成果物の帰属先,支払方法,備考"));
  // 1行だけだと「作品が違えば別の発注書」が伝わらない。
  assert.equal(csv.trimEnd().split("\n").length, 3);
  assert.ok(csv.includes("契約種別・支払条件"));
});

test("行を明細として読む。桁区切り・スラッシュの日付・帰属先の表記ゆれを吸収する", () => {
  const rows = readRows(CSV);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].item.unit_price, 8000);
  assert.equal(rows[1].item.quantity, 12);
  assert.equal(rows[1].item.amount_ex_tax, 96000);
  assert.equal(rows[1].item.delivery_date, "2026-10-31");
  assert.equal(rows[1].item.deliverable_ownership, "発注者");
  assert.equal(rows[1].item.calc_method, "FIXED", "空なら固定額");
  assert.deepEqual(rows[1].issues, []);
  assert.match(rows[3].issues[0], /固定額 だけ/);
});

test("見出しが雛形と違えば止める", () => {
  assert.throws(() => readRows("a,b,c\\n1,2,3"), /見出しが雛形と合いません/);
});

test("作品を書かなければ、同じ取引先の行が1束（1枚の発注書）にまとまる", () => {
  const groups = groupRows(readRows(CSV));
  assert.equal(groups.length, 3);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].total, 246000);
  assert.equal(groups[1].key, "name:ヨシザワ アツオ／wnone／cauto");
});

test("同じ取引先でも作品が違えば別の束になる", () => {
  // 取引先だけで束ねていたので、作品が何本かある案件では1枚に混ざっていた。
  const groups = groupRows(readRows(CSV_WORKS));
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((g) => g.rows.length), [2, 1, 1]);
  assert.equal(groups[0].key, "code:vd-00317／wcode:wrk-10013／cauto");
  assert.equal(groups[0].total, 230000);
  assert.equal(groups[1].key, "code:vd-00317／wcode:wrk-10021／cauto");
  assert.equal(groups[2].key, "name:株式会社ヒナタ翻訳／wname:夜明けのクロニクル／cauto");
});

/** 取引先の当たり方。コード → 名前 の順で、1件に決まるときだけ。 */
const parties = (t: string, params: unknown[]) => {
  if (t.includes("lower(btrim(party_code))")) {
    return params[0] === "VD-00317" ? [{ id: 2, name: "合同会社アトリエ蒼", party_code: "VD-00317" }]
      : params[0] === "VD-00120" ? [{ id: 5, name: "株式会社ヒナタ翻訳", party_code: "VD-00120" }] : [];
  }
  if (t.includes("btrim(name) = btrim($1)")) {
    return params[0] === "合同会社アトリエ蒼" ? [{ id: 2, name: "合同会社アトリエ蒼", party_code: "VD-00317" }]
      : params[0] === "株式会社ヒナタ翻訳" ? [{ id: 9, name: "株式会社ヒナタ翻訳", party_code: "VD-00388" }] : [];
  }
  return undefined;
};

/** 作品の当たり方。コード → 題名 の順で、1件に決まるときだけ。 */
const works = (t: string, params: unknown[]) => {
  if (t.includes("lower(btrim(work_code))")) {
    return params[0] === "WRK-10013" ? [{ id: 11, title: "星降る夜のミュゼ", work_code: "WRK-10013" }]
      : params[0] === "WRK-10021" ? [{ id: 12, title: "夜明けのクロニクル", work_code: "WRK-10021" }] : [];
  }
  if (t.includes("btrim(title) = btrim($1)")) {
    return params[0] === "夜明けのクロニクル" ? [{ id: 12, title: "夜明けのクロニクル", work_code: "WRK-10021" }] : [];
  }
  return undefined;
};

const build = (extra: (t: string, p: unknown[]) => Array<Record<string, unknown>> | undefined = () => undefined) => {
  const db = new FakeDatabase((t, p) => extra(t, p) ?? parties(t, p) ?? works(t, p) ?? (
    t.includes("FROM matters WHERE id") ? [{ id: 3, kind: "outsourcing", title: "第4巻 挿絵発注" }] : undefined));
  const svc = new DocumentBatchService(db, {} as any, {} as any, {} as any);
  return { db, svc };
};

test("突き合わせ：1件に決まれば作る、コードと名前が別を指せば選ぶ、当たらなければ飛ばす", async () => {
  const { db, svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV });
  assert.deepEqual(r.groups.map((g) => g.action), ["create", "skip", "choose"]);
  assert.equal(r.groups[0].party?.id, 2);
  assert.equal(r.groups[0].condition.mode, "new");
  assert.deepEqual(r.groups[2].candidates.map((c) => c.id), [5, 9], "コードの当たりを先に出す");
  assert.equal(r.summary.creatable, 1);
  assert.equal(r.summary.skipped, 1);
  assert.equal(r.summary.choose, 1);
  assert.equal(db.find("INSERT INTO"), undefined, "突き合わせでは何も作らない");
});

test("突き合わせ：候補を選べば作れる側に移る。ただし行の不備（固定額以外）は飛ばす", async () => {
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV,
                                choices: { "code:vd-00120／wnone／cauto": 5 } });
  assert.equal(r.groups[2].resolution, "resolved");
  assert.equal(r.groups[2].action, "skip", "支払方法が業績連動の行があるので作れない");
  assert.match(r.groups[2].issues.join(" "), /固定額 だけ/);
});

test("突き合わせ：その取引先の定額・委託料の条件がこの案件にあれば「既存」に当てる", async () => {
  const { svc } = build((t) =>
    t.includes("c.pricing_model = 'fixed'") ? [{ id: 44, condition_no: "CL-2026-00044" }] : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV });
  assert.equal(r.groups[0].condition.mode, "existing");
  assert.equal(r.groups[0].condition.id, 44);
  assert.equal(r.groups[0].condition.conditionNo, "CL-2026-00044");
  // 既存に当てる束は、いまの基本契約のまま触らない。
  assert.equal(r.groups[0].condition.agreement, null);
});

test("発注書以外のひな形では一括を受けない", async () => {
  const { svc } = build();
  await assert.rejects(
    () => svc.preview({ templateKey: "license_master", matterId: 3, csv: CSV }), /発注書（国内・海外）だけ/);
});

test("束の帰属先は行が揃っているときだけ条件に持たせる", () => {
  const rows = readRows(CSV);
  assert.equal(ownershipOfRows(rows.slice(0, 2)), "orderer");
  const mixed = [rows[0], { ...rows[3], item: { ...rows[3].item, deliverable_ownership: "受注者" } }];
  assert.equal(ownershipOfRows(mixed), null, "発注者と受注者が混ざっている");
  assert.equal(ownershipOfRows([{ ...rows[0], item: { ...rows[0].item, deliverable_ownership: null } }]), null, "空なら決めない");
});

test("突き合わせ：作品ごとに別の束になり、作品が当たれば作れる", async () => {
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.equal(r.summary.groups, 3);
  assert.deepEqual(r.groups.map((g) => g.action), ["create", "create", "create"]);
  assert.deepEqual(r.groups.map((g) => g.work?.id), [11, 12, 12]);
  assert.deepEqual(r.groups.map((g) => g.workResolution), ["resolved", "resolved", "resolved"]);
});

test("突き合わせ：作品を書いていない束は「作品なし」で、飛ばさない", async () => {
  // 作品に紐づかない委託がある。書いていないことは誤りではない。
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV });
  assert.equal(r.groups[0].workResolution, "none");
  assert.equal(r.groups[0].action, "create");
});

test("突き合わせ：書いてある作品が当たらなければ飛ばす（作品なしで作らない）", async () => {
  // 黙って作品なしで作ると、どの作品の仕事か辿れない条件明細が残る。
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,WRK-99999,,,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].workResolution, "missing");
  assert.equal(r.groups[0].action, "skip");
  assert.match(r.groups[0].issues.join(" "), /作品が見つからない/);
});

test("突き合わせ：作品の候補が複数なら選ぶ。選べば作れる側に移る", async () => {
  const { svc } = build((t, p) =>
    t.includes("lower(btrim(work_code))") && p[0] === "WRK-10013"
      ? [{ id: 11, title: "星降る夜のミュゼ", work_code: "WRK-10013" },
         { id: 13, title: "星降る夜のミュゼ（愛蔵版）", work_code: "WRK-10013" }]
      : undefined);
  const csv = `${HEAD}
VD-00317,合同会社アトリエ蒼,WRK-10013,,,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,`;
  const key = "code:vd-00317／wcode:wrk-10013／cauto";
  const before = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv });
  assert.equal(before.groups[0].action, "choose");
  assert.deepEqual(before.groups[0].workCandidates.map((w) => w.id), [11, 13]);
  const after = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv,
                                    workChoices: { [key]: 13 } });
  assert.equal(after.groups[0].workResolution, "resolved");
  assert.equal(after.groups[0].work?.id, 13);
  assert.equal(after.groups[0].action, "create");
});

test("既存の条件に当てるときは作品まで見る", async () => {
  // 作品を見ないと、作品が何本かある案件で別の作品の条件にぶら下がる。
  const seen: unknown[][] = [];
  const { svc } = build((t, p) => {
    if (!t.includes("c.pricing_model = 'fixed'")) return undefined;
    seen.push(p);
    return p[2] === 11 ? [{ id: 44, condition_no: "CL-2026-00044" }] : [];
  });
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.ok(seen.every((p) => p.length === 4), "作品IDと条件名を渡している");
  assert.equal(r.groups[0].condition.id, 44);
  assert.equal(r.groups[1].condition.mode, "new", "別の作品なので当てない");
});

test("作品が決まっていない束では、既存の条件を引かない", async () => {
  // 引くと作品なしの条件に当たって「既存」と出る。飛ばす束なのに
  // 当たっているように見え、表が読めなくなる。
  const { svc } = build((t) =>
    t.includes("c.pricing_model = 'fixed'") ? [{ id: 44, condition_no: "CL-2026-00044" }] : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,WRK-99999,,,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].workResolution, "missing");
  assert.equal(r.groups[0].condition.mode, "new");
});

test("予定明細は CSV の1行が1回。納期と支払日をそのまま持つ", () => {
  // 予定が無いと、実績を入れるときに「どの回の分か」が選べず、
  // 検収書の支払日が空欄で出る。
  const lines = scheduleLinesFrom(readRows(CSV_WORKS).slice(0, 2));
  assert.deepEqual(lines, [
    { seq: 1, label: "表紙イラスト", triggerKind: "on_inspection",
      plannedAmount: 150000, dueOn: "2026-10-31", payOn: "2026-11-30" },
    { seq: 2, label: "挿絵", triggerKind: "on_inspection",
      plannedAmount: 80000, dueOn: "2026-10-31", payOn: "2026-11-30" }
  ]);
});

test("0円の行は予定明細に置かない（置けない）", () => {
  const rows = readRows(CSV_WORKS).slice(0, 2);
  const zeroed = [{ ...rows[0], amount: 0 }, rows[1]];
  assert.deepEqual(scheduleLinesFrom(zeroed).map((l) => l.seq), [1]);
  assert.equal(scheduleLinesFrom(zeroed)[0].plannedAmount, 80000);
});

/** 締結済みの基本契約（取得側）を1件だけ持つ取引先。 */
const agreement = (t: string) =>
  t.includes("FROM agreements") && t.includes("direction = 'in'")
    ? [{ id: 7, agreement_no: "AGR-2025-0011", title: "制作業務委託基本契約" }] : undefined;

test("新しく作る条件には、その取引先の締結済みの基本契約を当てる", async () => {
  // 条件明細は基本契約にぶら下がる。付けずに作ると鎖の1本目が切れ、
  // 契約の画面からこの発注が見えない。
  const { svc } = build((t) => agreement(t));
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.equal(r.groups[0].condition.mode, "new");
  assert.deepEqual(r.groups[0].condition.agreement,
    { id: 7, agreementNo: "AGR-2025-0011", title: "制作業務委託基本契約" });
  assert.equal(r.groups[0].condition.agreementNote, null);
  assert.equal(r.groups[0].condition.schedules, 2, "行の数だけ回ができる");
});

test("この案件で既に使っている基本契約を優先する", async () => {
  const { svc } = build((t) =>
    t.includes("JOIN agreements a ON a.id = c.agreement_id")
      ? [{ id: 9, agreement_no: "AGR-2024-0002", title: "旧・制作業務委託基本契約" }]
      : agreement(t));
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.equal(r.groups[0].condition.agreement?.id, 9);
});

test("基本契約が決まらなくても止めない。理由だけ残す", async () => {
  // 発注書は基本契約なしでも出せる（相手と基本契約を交わしていない単発）。
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.equal(r.groups[0].condition.agreement, null);
  assert.match(r.groups[0].condition.agreementNote ?? "", /基本契約が見つかりません/);
  assert.equal(r.groups[0].action, "create", "止める理由にはしない");
  assert.equal(r.groups[0].issues.length, 0, "不備としては数えない");
});

test("基本契約の候補が複数なら当てない。あとで人が選ぶ", async () => {
  const { svc } = build((t) =>
    t.includes("FROM agreements") && t.includes("direction = 'in'")
      ? [{ id: 7, agreement_no: "A-1", title: "基本契約1" },
         { id: 8, agreement_no: "A-2", title: "基本契約2" }]
      : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: CSV_WORKS });
  assert.equal(r.groups[0].condition.agreement, null);
  assert.match(r.groups[0].condition.agreementNote ?? "", /複数あります/);
  assert.equal(r.groups[0].action, "create");
});

test("起点は雛形の言葉・短い言葉・中の値のどれでも読む", () => {
  // 人が手で書き足す欄。表記を1つに縛ると「検収」と書いただけで全行が不備になる。
  assert.equal(readTriggerKind("検収後"), "on_inspection");
  assert.equal(readTriggerKind("検収"), "on_inspection");
  assert.equal(readTriggerKind("on_inspection"), "on_inspection");
  assert.equal(readTriggerKind("納品後"), "on_delivery");
  assert.equal(readTriggerKind("契約時"), "on_execution");
  assert.equal(readTriggerKind("着手金"), "on_execution");
  assert.equal(readTriggerKind("定期"), "periodic");
  assert.equal(readTriggerKind("毎月"), "periodic");
  assert.equal(readTriggerKind(""), null);
  assert.equal(readTriggerKind("出来高"), null);
});

test("起点は必須。空でも読めなくても、その行は不備になる", () => {
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,表紙,カラー1点,1,150000,,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,,挿絵,カラー1点,1,150000,出来高,2026-10-31,2026-11-30,,発注者,固定額,`);
  assert.match(rows[0].issues.join(" "), /起点が空/);
  assert.match(rows[1].issues.join(" "), /起点が読めない（出来高）/);
  assert.equal(rows[0].triggerKind, null);
});

test("起点の列が無ければ、行ごとの不備を並べずに雛形を取り直させる", () => {
  // 古い雛形のファイルは全行が不備になる。何百件並べても直しようがない。
  const old = "取引先コード,取引先名,品目・業務名,仕様・成果物,数量,単価（税抜）,納期,支払日,成果物の帰属先,支払方法,備考\n"
    + "VD-00317,合同会社アトリエ蒼,表紙,カラー1点,1,150000,2026-10-31,2026-11-30,発注者,固定額,";
  assert.throws(() => readRows(old), /「起点」の列がありません/);
});

test("予定明細の起点は行ごと。1つの束の中でも変わる", () => {
  // 着手金は契約時、本編は検収後。束でひとつに決められない。
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,着手金,一式,1,50000,契約時,2026-09-30,2026-10-31,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,,本編,カラー10点,10,15000,検収後,2026-10-31,2026-11-30,,発注者,固定額,`);
  assert.deepEqual(scheduleLinesFrom(rows).map((l) => [l.seq, l.label, l.triggerKind]), [
    [1, "着手金", "on_execution"],
    [2, "本編", "on_inspection"]
  ]);
});

test("雛形の例は起点が埋まっている", () => {
  // 空の見本を配ると、そのまま返ってきて全行が不備になる。
  const [, first] = templateCsv().trimEnd().split("\n");
  assert.ok(first.includes("検収後"));
});

test("契約種別・支払条件は行の欄。発注書の明細にそのまま出る", () => {
  // フォームの発注明細にある欄。CSV に無かったので人が後から打ち直していた。
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,月末締め翌月末払い,発注者,固定額,`);
  assert.equal(rows[0].item.payment_terms, "月末締め翌月末払い");
});

test("条件名を書けば、同じ取引先・同じ作品でも束が分かれる", () => {
  // 分ける手立てが他に無い。人が名前で決められるようにしておく。
  const groups = groupRows(readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,WRK-10013,,,第1期 制作,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,WRK-10013,,,第2期 制作,挿絵,カラー1点,1,120000,検収後,2027-01-31,2027-02-28,,発注者,固定額,`));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.conditionName), ["第1期 制作", "第2期 制作"]);
  assert.equal(groups[0].key, "code:vd-00317／wcode:wrk-10013／cname:第1期 制作");
});

test("契約番号を書けば、その契約を当てる（自動判定より強い）", async () => {
  const { svc } = build((t, p) =>
    t.includes("FROM agreements") && t.includes("lower(btrim(agreement_no))")
      ? [{ id: 7, agreement_no: "AGR-2025-0011", title: "制作業務委託基本契約", counterparty_id: 2 }]
      : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,,,AGR-2025-0011,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].condition.agreement?.id, 7);
  assert.equal(r.groups[0].action, "create");
});

test("契約番号が別の取引先の契約なら飛ばす", async () => {
  // 番号の写し間違いを黙って通すと、関係の無い契約に発注が紐づく。
  const { svc } = build((t) =>
    t.includes("lower(btrim(agreement_no))")
      ? [{ id: 7, agreement_no: "AGR-2025-0011", title: "別の契約", counterparty_id: 99 }]
      : undefined);
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,,,AGR-2025-0011,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].action, "skip");
  assert.match(r.groups[0].issues.join(" "), /この取引先の契約ではありません/);
});

test("契約番号が見つからなければ飛ばす（基本契約なしで作らない）", async () => {
  // 黙って作ると、紙がスポット契約の約款で出る。
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,,,AGR-9999-9999,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].action, "skip");
  assert.match(r.groups[0].issues.join(" "), /契約番号 AGR-9999-9999 が見つかりません/);
});

test("契約番号が行ごとに違えば飛ばす（条件明細に契約は1つ）", async () => {
  const { svc } = build();
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,,,AGR-A,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,AGR-B,,挿絵,カラー1点,1,120000,検収後,2026-10-31,2026-11-30,,発注者,固定額,` });
  assert.equal(r.groups[0].action, "skip");
  assert.match(r.groups[0].issues.join(" "), /契約番号が行ごとに違います/);
});

test("束の中で揃っている値だけを条件に持たせる", () => {
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,翌月末,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,,挿絵,カラー1点,1,120000,検収後,2026-10-31,2026-11-30,翌月末,発注者,固定額,`);
  assert.equal(sameAcross(rows, (r) => (r.item.payment_terms as string | null) ?? null), "翌月末");
  const mixed = [rows[0], { ...rows[1], item: { ...rows[1].item, payment_terms: "当月末" } }];
  assert.equal(sameAcross(mixed, (r) => (r.item.payment_terms as string | null) ?? null), null);
});

test("数量が小数でも、行の金額は四捨五入して整数になる", () => {
  // 端数のまま条件明細の金額欄（bigint）へ渡すと
  // invalid input syntax for type bigint: "157987.5" で落ちる。
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,校正,一式,1.5,3333,検収後,2027-01-31,2027-02-28,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,,追加,一式,0.5,1001,検収後,2027-01-31,2027-02-28,,発注者,固定額,`);
  // 数量と単価はそのまま。金額だけ丸める。
  assert.equal(rows[0].item.quantity, 1.5);
  assert.equal(rows[0].item.unit_price, 3333);
  assert.equal(rows[0].amount, 5000, "4999.5 → 5000");
  assert.equal(rows[0].item.amount_ex_tax, 5000);
  assert.equal(rows[1].amount, 501, "500.5 → 501");
  // 束の合計も整数。行を丸めてから足すので、明細の合計と総額が必ず合う。
  const [group] = groupRows(rows);
  assert.equal(group.total, 5501);
  assert.ok(Number.isInteger(group.total));
});

test("小数の金額でも予定明細が置ける", () => {
  // 予定明細は 0円以下を弾く。丸める前は 0.4 のような行が 0 になって
  // 置けなかった（丸めれば 0 のままなので落ちるのは同じだが、
  // 1円以上になる行は置けるようになる）。
  const rows = readRows(`${HEAD}
VD-00317,合同会社アトリエ蒼,,,,,校正,一式,1.5,3333,検収後,2027-01-31,2027-02-28,,発注者,固定額,`);
  assert.deepEqual(scheduleLinesFrom(rows).map((l) => l.plannedAmount), [5000]);
});

test("条件名を書いたときは、同じ名前の条件にだけ当てる", async () => {
  // 束は名前で分かれるのに当てるほうが名前を見ないと、別の名前を書いても
  // 同じ条件にぶら下がり、名前が捨てられる（分ける手立てが無くなる）。
  const seen: unknown[][] = [];
  const { svc } = build((t, p) => {
    if (!t.includes("c.pricing_model = 'fixed'")) return undefined;
    seen.push(p);
    return p[3] === "第1期 制作" ? [{ id: 44, condition_no: "CL-2026-00044" }] : [];
  });
  const r = await svc.preview({ templateKey: "purchase_order", matterId: 3, csv: `${HEAD}
VD-00317,合同会社アトリエ蒼,,,,第1期 制作,表紙,カラー1点,1,150000,検収後,2026-10-31,2026-11-30,,発注者,固定額,
VD-00317,合同会社アトリエ蒼,,,,第2期 制作,挿絵,カラー1点,1,120000,検収後,2027-01-31,2027-02-28,,発注者,固定額,` });
  assert.deepEqual(seen.map((p) => p[3]), ["第1期 制作", "第2期 制作"]);
  assert.equal(r.groups[0].condition.id, 44, "同じ名前の条件に当たる");
  assert.equal(r.groups[1].condition.mode, "new", "別の名前なので新しく作る");
});
