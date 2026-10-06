import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { DomainError } from "../core/errors.js";
import { PubWorksImportService, parseShareText } from "./pub-works.js";

test("取り分の列：名前（取引先コード） 率。電子の料率を分けた率で読む。合計が 100 なら比率。コードが無ければ止める", () => {
  assert.deepEqual(parseShareText("作家B（V-21） 10／作家C(V-22) 5", 15).map((s) => [s.name, s.code, s.ppm]),
    [["作家B", "V-21", 666667], ["作家C", "V-22", 333333]]);
  assert.deepEqual(parseShareText("瀧里フユ（V-0102） 75%; 宝井ロメロ（V-0188） 25%", 15).map((s) => s.ppm), [750000, 250000]);
  assert.deepEqual(parseShareText("", 15), []);
  assert.throws(() => parseShareText("作家B（V-21） 10／作家C（V-22） 4", 15), (e: unknown) => e instanceof DomainError && /合計が合いません/.test(e.message));
  assert.throws(() => parseShareText("作家B（V-21）", 15), (e: unknown) => e instanceof DomainError && /名前（取引先コード） 10／/.test(e.message));
  assert.throws(() => parseShareText("作家B 10／作家C（V-22） 5", 15),
    (e: unknown) => e instanceof DomainError && /「作家B」に取引先コードがありません/.test(e.message));
});

interface Options {
  works?: Array<{ id: number; work_code: string | null; title: string }>;
  parties?: Record<string, { id: number; name: string; code?: string }>;
  existing?: Array<{ condition_no: string; usage_type: string }>;
  /** update で当たる紙・電子の条件。 */
  pub?: Array<{ id: number; condition_no: string; usage_type: string; rate_ppm: number; exclusivity: string;
                counterparty_id: number; party_name: string }>;
  /** update で読む、いまの取り分。 */
  shares?: Array<{ party_id: number; party_name: string; share_ppm: number }>;
}
const db = (o: Options = {}) => new FakeDatabase((text, params) => {
  if (text.includes("SELECT id, work_code, title FROM works")) {
    return (o.works ?? []).filter((w) => (params[0] ? w.work_code === params[0] : w.title === params[1]));
  }
  if (text.includes("SELECT id, name FROM parties")) {
    const hit = (o.parties ?? {})[String(params[1] || params[0])];
    return hit ? [hit] : [];
  }
  if (text.includes("SELECT id, name, name_kana, aliases FROM parties")) {
    const hit = Object.values(o.parties ?? {}).find((p) => p.code === params[0]);
    return hit ? [{ ...hit, name_kana: null, aliases: [] }] : [];
  }
  if (text.includes("FROM conditions") && text.includes("usage_type = ANY")) return o.existing ?? [];
  if (text.includes("c.usage_type IN ('pub_print', 'pub_digital')") && text.includes("c.work_id = $1")) {
    return (o.pub ?? []).filter((c) => params[1] === null || c.counterparty_id === params[1]);
  }
  if (text.includes("FROM condition_shares s")) {
    return (o.shares ?? []).map((s) => ({ ...s, party_kind: "individual", sort_order: 0, note: null }));
  }
  return undefined;
});
const PARTIES = { "冒険支援株式会社": { id: 11, name: "冒険支援株式会社", code: "V-11" },
                  "作家B": { id: 21, name: "作家B", code: "V-21" }, "作家C": { id: 22, name: "作家C", code: "V-22" } };

const deps = () => {
  const calls: Array<{ what: string; args: unknown[] }> = [];
  return {
    calls,
    works: {
      create: async (input: unknown) => { calls.push({ what: "work", args: [input] }); return { id: 77, workCode: "WRK-2026-0077" }; },
      update: async (...args: unknown[]) => { calls.push({ what: "work.update", args }); return {}; }
    },
    conditions: {
      createPublishingSet: async (input: unknown) => {
        calls.push({ what: "set", args: [input] });
        return { print: { id: 501, conditionNo: "CL-501" }, digital: { id: 502, conditionNo: "CL-502" } };
      },
      updateEconomics: async (...args: unknown[]) => { calls.push({ what: "economics", args }); return {}; },
      replaceShares: async (...args: unknown[]) => { calls.push({ what: "shares", args }); return {}; },
      replaceScopes: async (...args: unknown[]) => { calls.push({ what: "scopes", args }); return {}; }
    }
  };
};

const ROW = { "作品名": "新しい作品", "相手先": "冒険支援株式会社", "紙料率": "10", "電子料率": "15",
              "取り分": "作家B（V-21） 10／作家C（V-22） 5", "分配": "当社", "CID": "BT0001／BT0002", "言語": "日本語" };

test("試算：作品が無ければ「新しく作る」、紙・電子・取り分・CID を読み上げる。書かない", async () => {
  const fake = db({ parties: PARTIES });
  const d = deps();
  const r = await new PubWorksImportService(fake, d).run([ROW], true, "tester");
  assert.equal(r.ok, 1);
  assert.match(r.rows[0].message ?? "", /作品を新しく作る・紙 10%・電子 15%・相手先 冒険支援株式会社・取り分 作家B 66.67%／作家C 33.33%（当社が分配）・CID 2 件/);
  assert.equal(d.calls.length, 0);
  assert.equal(fake.all("INSERT").length, 0);
});

test("登録：作品を作り、出版セットを作り、電子の条件に取り分（作品全体に反映）、CID を覚える", async () => {
  const fake = db({ parties: PARTIES });
  const d = deps();
  const r = await new PubWorksImportService(fake, d).run([ROW], false, "tester");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.equal(r.rows[0].code, "WRK-2026-0077");
  assert.deepEqual(d.calls.map((c) => c.what), ["work", "set", "shares"]);
  const set = d.calls[1].args[0] as Record<string, any>;
  assert.equal(set.counterpartyId, 11);
  assert.equal(set.workId, 77);
  assert.deepEqual(set.print, { ratePct: 10, exclusivity: "non_exclusive" });
  assert.deepEqual(set.digital, { ratePct: 15, exclusivity: "non_exclusive" });
  const shares = d.calls[2].args;
  assert.equal(shares[0], 502, "電子の条件に入れる");
  assert.deepEqual(shares[1], [{ partyId: 21, sharePpm: 666667 }, { partyId: 22, sharePpm: 333333 }]);
  assert.equal(shares[3], "direct");
  assert.deepEqual(shares[4], { applyToWork: true }, "紙にも同じ按分");
  assert.equal(fake.all("INSERT INTO ebook_work_codes").length, 2);
});

test("既存の作品に当たれば作らない。同じ相手先の紙・電子があれば重複", async () => {
  const works = [{ id: 7, work_code: "WRK-7", title: "新しい作品" }];
  const d = deps();
  const r = await new PubWorksImportService(db({ parties: PARTIES, works }), d).run([ROW], false, "tester");
  assert.equal(r.ok, 1);
  assert.match(r.rows[0].message ?? "", /既存の作品 WRK-7/);
  assert.equal(d.calls[0].what, "set", "作品は作らない");

  const dup = await new PubWorksImportService(db({ parties: PARTIES, works, existing: [{ condition_no: "CL-9", usage_type: "pub_digital" }] }), deps())
    .run([ROW], true, "tester");
  assert.equal(dup.duplicate, 1);
  assert.match(dup.rows[0].message ?? "", /電子（CL-9）が既にあります/);
});

test("止める：相手先なし・料率なし・代表が取り分に無い・知らないコード・コードと名前が合わない・コードなし", async () => {
  const svc = new PubWorksImportService(db({ parties: PARTIES }), deps());
  const r = await svc.run([
    { ...ROW, "相手先": "" },
    { ...ROW, "紙料率": "", "電子料率": "" },
    { ...ROW, "分配": "代表" },
    { ...ROW, "取り分": "作家B（V-21） 10／誰か（V-99） 5" },
    { ...ROW, "取り分": "作家B（V-21） 10／作家X（V-22） 5" },
    { ...ROW, "取り分": "作家B（V-21） 10／作家C 5" }
  ], true, "tester");
  assert.equal(r.error, 6);
  assert.match(r.rows[0].message ?? "", /相手先が空/);
  assert.match(r.rows[1].message ?? "", /紙料率か電子料率/);
  assert.match(r.rows[2].message ?? "", /相手先（代表）を取り分の中に/);
  assert.match(r.rows[3].message ?? "", /取引先コード「V-99」が見つかりません/);
  assert.match(r.rows[4].message ?? "", /「作家X」と取引先コード「V-22」が合いません（コード V-22 は「作家C」です）/);
  assert.match(r.rows[5].message ?? "", /「作家C」に取引先コードがありません/);
});

// ---- 既存の作品の一括修正（update） ---------------------------------------

const PUB = [
  { id: 601, condition_no: "CL-601", usage_type: "pub_print", rate_ppm: 100000, exclusivity: "non_exclusive", counterparty_id: 11, party_name: "冒険支援株式会社" },
  { id: 602, condition_no: "CL-602", usage_type: "pub_digital", rate_ppm: 150000, exclusivity: "non_exclusive", counterparty_id: 11, party_name: "冒険支援株式会社" }
];
const WORKS = [{ id: 7, work_code: "WRK-7", title: "新しい作品" }];

test("更新：作品コードで当て、書いてある列だけ直す（料率は電子だけ変わる・取り分は作品全体・CID）。試算は書かない", async () => {
  const row = { "作品コード": "WRK-7", "紙料率": "10", "電子料率": "20", "取り分": "作家B（V-21） 10／作家C（V-22） 10", "CID": "BT0009" };
  const d = deps();
  const fake = db({ parties: PARTIES, works: WORKS, pub: PUB });
  const dry = await new PubWorksImportService(fake, d).run([row], true, "tester", "update");
  assert.equal(dry.ok, 1, JSON.stringify(dry.rows));
  assert.equal(dry.mode, "update");
  assert.match(dry.rows[0].message ?? "", /作品 WRK-7 の 電子（CL-602）の料率 20%・取り分 作家B 50%／作家C 50%（当社が分配）・CID 1 件 を更新します/);
  assert.doesNotMatch(dry.rows[0].message ?? "", /紙（CL-601）/, "紙は 10% のままなので触らない");
  assert.equal(d.calls.length, 0);

  const r = await new PubWorksImportService(fake, d).run([row], false, "tester", "update");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.deepEqual(d.calls.map((c) => c.what), ["economics", "shares"]);
  assert.deepEqual(d.calls[0].args.slice(0, 2), [602, { ratePpm: 200000 }]);
  assert.equal(d.calls[1].args[0], 602, "取り分は電子の条件から");
  assert.deepEqual(d.calls[1].args[1], [{ partyId: 21, sharePpm: 500000 }, { partyId: 22, sharePpm: 500000 }]);
  assert.deepEqual(d.calls[1].args[4], { applyToWork: true });
  assert.equal(fake.all("INSERT INTO ebook_work_codes").length, 1);
});

test("更新：取り分は新しい電子料率が無ければ、いまの料率（15%）を分けた率で読む。「なし」で消す。分配だけも替えられる", async () => {
  const d = deps();
  const r = await new PubWorksImportService(db({ parties: PARTIES, works: WORKS, pub: PUB,
    shares: [{ party_id: 21, party_name: "作家B", share_ppm: 600000 }, { party_id: 22, party_name: "作家C", share_ppm: 400000 }] }), d)
    .run([
      { "作品名": "新しい作品", "取り分": "作家B（V-21） 11.25／作家C（V-22） 3.75" },
      { "作品名": "新しい作品", "取り分": "なし" },
      { "作品名": "新しい作品", "分配": "代表" }
    ], false, "tester", "update");
  assert.equal(r.ok, 2, JSON.stringify(r.rows));
  assert.equal(r.error, 1);
  assert.deepEqual(d.calls[0].args[1], [{ partyId: 21, sharePpm: 750000 }, { partyId: 22, sharePpm: 250000 }]);
  assert.deepEqual(d.calls[1].args[1], [], "「なし」で消す");
  assert.match(r.rows[1].message ?? "", /取り分を消す/);
  // 代表（相手先 #11）が取り分に無いので止まる。
  assert.match(r.rows[2].message ?? "", /相手先（代表）を取り分の中に/);
});

test("更新：条件が無い媒体に料率があれば、その媒体の条件を作る。作品が無ければ止める。当てる列が無ければ変更なし", async () => {
  const d = deps();
  const r = await new PubWorksImportService(db({ parties: PARTIES, works: WORKS, pub: [PUB[0]] }), d).run([
    { "作品コード": "WRK-7", "電子料率": "15", "カナ": "アタラシイサクヒン" },
    { "作品コード": "WRK-999", "電子料率": "15" },
    { "作品コード": "WRK-7" }
  ], false, "tester", "update");
  assert.equal(r.ok, 1, JSON.stringify(r.rows));
  assert.equal(r.error, 1);
  assert.equal(r.skipped, 1);
  assert.match(r.rows[0].message ?? "", /作品のカナ・電子の条件を新しく作る（15%・相手先 冒険支援株式会社）/);
  assert.deepEqual(d.calls.map((c) => c.what), ["work.update", "set"]);
  const set = d.calls[1].args[0] as Record<string, any>;
  assert.equal(set.counterpartyId, 11, "相手先は紙の条件から");
  assert.equal(set.print, null);
  assert.deepEqual(set.digital, { ratePct: 15, exclusivity: "non_exclusive" });
  assert.match(r.rows[1].message ?? "", /見つかりません。新しく作るなら「新しく登録する」/);
  assert.match(r.rows[2].message ?? "", /当てる項目がありません/);
});

test("書き出し：作品 × 相手先で 1 行。取り分は電子の料率を分けた率で、そのまま取り込める", async () => {
  const fake = new FakeDatabase((text) => {
    if (text.includes("FROM conditions c") && text.includes("JOIN works w")) {
      const base = { work_id: 7, title: "光砕のリヴァルチャー", work_code: "WRK-7", title_kana: null, business_line: "出版",
                     work_remarks: null, copyright_notice: null, third_party_rights: null, counterparty_id: 11,
                     party_name: "瀧里フユ", party_code: "P-11", agreement_no: null, term_start: "2025-07-01", term_end: null,
                     payment_terms: null, notes: null, distribution: "direct", exclusivity: "non_exclusive" };
      return [{ ...base, id: 601, usage_type: "pub_print", rate_ppm: 100000 },
              { ...base, id: 602, usage_type: "pub_digital", rate_ppm: 150000 }];
    }
    if (text.includes("FROM condition_shares s")) {
      return [{ condition_id: 602, name: "瀧里フユ", party_code: "V-0102", share_ppm: 750000 },
              { condition_id: 602, name: "宝井ロメロ", party_code: null, share_ppm: 250000 }];
    }
    if (text.includes("FROM condition_scopes")) return [{ condition_id: 602, scope_type: "language", label: "日本語" }];
    if (text.includes("FROM ebook_work_codes")) return [{ work_id: 7, cid: "BT0001" }];
    return undefined;
  });
  const csv = await new PubWorksImportService(fake, deps()).exportCsv();
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "作品名,作品コード,カナ,相手先,相手先コード,紙料率,電子料率,独占,取り分,分配,CID,契約番号,開始日,終了日,支払条件,地域,言語,著作権表示,第三者権利,備考,作品備考,事業区分");
  assert.equal(lines[1], "光砕のリヴァルチャー,WRK-7,,瀧里フユ,P-11,10,15,非独占,瀧里フユ（V-0102） 11.25／宝井ロメロ 3.75,当社,BT0001,,2025-07-01,,,,日本語,,,,,出版");
  // 書き出した取り分はそのまま読める。コードの無い権利者は取り込むときに止まる（先に取引先にコードを付ける）。
  assert.deepEqual(parseShareText("瀧里フユ（V-0102） 11.25／宝井ロメロ（V-0188） 3.75", 15).map((s) => s.ppm), [750000, 250000]);
  assert.throws(() => parseShareText("瀧里フユ（V-0102） 11.25／宝井ロメロ 3.75", 15),
    (e: unknown) => e instanceof DomainError && /「宝井ロメロ」に取引先コードがありません/.test(e.message));
});
