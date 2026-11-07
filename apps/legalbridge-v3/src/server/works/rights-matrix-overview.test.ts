import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverview, categoryOf, type OverviewWork } from "./rights-matrix-overview.js";
import type { MatrixGrant } from "./rights-matrix.js";

const JP = { code: "JP", label: "日本" };
const US = { code: "US", label: "アメリカ合衆国" };
const BR = { code: "BR", label: "ブラジル" };
const EN = { code: "en", label: "英語" };
const PT = { code: "pt", label: "ポルトガル語" };

const grant = (over: Partial<MatrixGrant> & { id: number }): MatrixGrant => ({
  conditionNo: `C-${over.id}`, name: "許諾", partyId: over.id, partyName: `相手${over.id}`, workId: 1, workTitle: "作品",
  usageLabel: "再許諾", exclusivity: "non_exclusive", termStart: "2026-01-01", termEnd: "2028-12-31", status: "active",
  regions: [], languages: [], ...over
});
const work = (over: Partial<OverviewWork> & { id: number }): OverviewWork => ({
  title: `作品${over.id}`, workCode: `W-${over.id}`, businessLine: null, inUsageTypes: [], derived: 0, grants: [],
  envelope: null, ...over
});
const env = (regions: typeof JP[]) => ({ acquiredCount: 1, scopes: [{ scopeType: "region" as const, values: regions }] });
const cell = (o: ReturnType<typeof buildOverview>, workId: number, lang: string) =>
  o.rows.find((r) => r.work.id === workId)!.cells.find((c) => c.language === lang)!;

test("カテゴリは事業区分、無ければ作家との条件の利用形態で決める", () => {
  assert.equal(categoryOf("ボードゲーム", []), "game");
  assert.equal(categoryOf("出版", ["in_house"]), "publishing");
  assert.equal(categoryOf(null, ["pub_paper"]), "publishing");
  assert.equal(categoryOf(null, ["oem"]), "game");
  assert.equal(categoryOf(null, []), "other");
});

test("全作品で同じ列（言語）にそろえ、地域を選ばなければ全地域を畳んで、いちばん気にすべき状態にする", () => {
  const o = buildOverview({
    today: "2026-11-07", includeEnded: false,
    works: [
      work({ id: 1, envelope: env([JP, US, BR]), grants: [
        grant({ id: 11, exclusivity: "exclusive", regions: [BR], languages: [PT] }),
        grant({ id: 12, regions: [BR], languages: [PT] })
      ] }),
      work({ id: 2, envelope: env([JP, US]), grants: [grant({ id: 21, regions: [US], languages: [EN] })] })
    ]
  });
  assert.deepEqual(o.languages.map((l) => l.label), ["ポルトガル語", "英語", "その他の言語"], "許諾の多い言語から");
  assert.equal(cell(o, 1, "pt").state, "conflict");
  assert.deepEqual(cell(o, 1, "pt").parties, ["相手11", "相手12"]);
  assert.equal(cell(o, 2, "en").state, "non_exclusive");
  assert.equal(cell(o, 2, "en").grantedRegions, 1);
  assert.equal(cell(o, 2, "en").openRegions, 1, "日本の英語は空き");
  assert.equal(cell(o, 2, "pt").state, "open");
  assert.equal(o.rows[0]!.work.id, 1, "ぶつかりのある作品が先頭");
  assert.equal(o.counts.conflict, 1);
});

test("地域を選ぶと、その地域のマスだけを出す", () => {
  const o = buildOverview({
    today: "2026-11-07", includeEnded: false, region: "JP",
    works: [work({ id: 2, envelope: env([JP, US]), grants: [grant({ id: 21, regions: [US], languages: [EN] })] })]
  });
  assert.equal(o.region, "JP");
  assert.equal(cell(o, 2, "en").state, "open");
  assert.deepEqual(cell(o, 2, "en").parties, []);
});

test("絞り込み：題名・カテゴリ・取引先・出す作品（許諾あり・問題あり・空きあり）", () => {
  const works = [
    work({ id: 1, title: "星海", businessLine: "出版", grants: [grant({ id: 11, partyId: 7, partyName: "版元", regions: [JP] })] }),
    work({ id: 2, title: "砂の城", businessLine: "ボードゲーム", envelope: env([JP]) }),
    work({ id: 3, title: "灯台", grants: [grant({ id: 31, termEnd: "2025-01-01" })] })
  ];
  const base = { today: "2026-11-07", includeEnded: false, works };
  assert.deepEqual(buildOverview(base).rows.map((r) => r.work.id), [1], "既定は許諾のある作品（終わった許諾だけの作品は出ない）");
  assert.deepEqual(buildOverview({ ...base, show: "all" }).rows.map((r) => r.work.id).sort(), [1, 2, 3]);
  assert.deepEqual(buildOverview({ ...base, show: "open" }).rows.map((r) => r.work.id), [2]);
  assert.deepEqual(buildOverview({ ...base, show: "all", category: "game" }).rows.map((r) => r.work.id), [2]);
  assert.deepEqual(buildOverview({ ...base, show: "all", q: "星" }).rows.map((r) => r.work.id), [1]);
  assert.deepEqual(buildOverview({ ...base, show: "all", partyId: 7 }).rows.map((r) => r.work.id), [1]);
  assert.deepEqual(buildOverview({ ...base, includeEnded: true }).rows.map((r) => r.work.id).sort(), [1, 3]);
  assert.deepEqual(buildOverview(base).parties, [{ id: 7, name: "版元" }]);
});
