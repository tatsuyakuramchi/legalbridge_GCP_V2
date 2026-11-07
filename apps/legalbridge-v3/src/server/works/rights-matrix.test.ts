import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRightsMatrix, type MatrixGrant } from "./rights-matrix.js";

const JP = { code: "JP", label: "日本" };
const US = { code: "US", label: "アメリカ合衆国" };
const BR = { code: "BR", label: "ブラジル" };
const JA = { code: "ja", label: "日本語" };
const EN = { code: "en", label: "英語" };
const PT = { code: "pt", label: "ポルトガル語" };

const grant = (over: Partial<MatrixGrant> & { id: number }): MatrixGrant => ({
  conditionNo: `C-${over.id}`, name: "許諾", partyId: over.id, partyName: `相手${over.id}`, workId: 1, workTitle: "作品",
  usageLabel: "再許諾", exclusivity: "non_exclusive", termStart: "2026-01-01", termEnd: "2028-12-31", status: "active",
  regions: [], languages: [], ...over
});
const envelope = (regions: typeof JP[], languages: typeof JA[]) => ({
  acquiredCount: 1,
  scopes: [{ scopeType: "region" as const, values: regions }, { scopeType: "language" as const, values: languages }]
});
const at = (m: ReturnType<typeof buildRightsMatrix>, r: string, l: string) => m.cells.find((c) => c.region === r && c.language === l)!;

test("行・列は条件に出てくる国・言語と「その他」。日本・日本語が先頭、全世界の許諾は全部のマスを覆う", () => {
  const m = buildRightsMatrix({
    work: { id: 1, title: "作品" }, today: "2026-11-07", includeEnded: false, envelope: null,
    grants: [
      grant({ id: 1, regions: [US], languages: [EN] }),
      grant({ id: 2, regions: [US, JP], languages: [EN] }),
      grant({ id: 3, regions: [{ code: "WORLD", label: "全世界" }], languages: [PT] })
    ]
  });
  assert.deepEqual(m.regions.map((r) => r.label), ["日本", "アメリカ合衆国", "その他の地域"]);
  assert.deepEqual(m.languages.map((l) => l.label), ["英語", "ポルトガル語", "その他の言語"]);
  assert.deepEqual(at(m, "US", "en").grantIds, [1, 2]);
  assert.deepEqual(at(m, "__other_region", "pt").grantIds, [3]);
  assert.deepEqual(at(m, "JP", "pt").grantIds, [3]);
  assert.equal(at(m, "__other_region", "en").state, "none", "作者の条件が無ければ空きとは言わない");
  assert.equal(m.acquired.known, false);
});

test("独占の許諾が、期間の重なるほかの相手の許諾とぶつかれば conflict。期間がずれれば、同じ相手ならぶつからない", () => {
  const m = buildRightsMatrix({
    work: { id: 1, title: "作品" }, today: "2026-11-07", includeEnded: false, envelope: null,
    grants: [
      grant({ id: 1, exclusivity: "exclusive", regions: [BR], languages: [PT] }),
      grant({ id: 2, regions: [BR], languages: [PT, EN] }),
      grant({ id: 3, exclusivity: "exclusive", regions: [US], languages: [EN], termEnd: "2026-12-31" }),
      grant({ id: 4, exclusivity: "exclusive", regions: [US], languages: [EN], termStart: "2027-01-01" }),
      grant({ id: 5, partyId: 1, regions: [BR], languages: [EN] }),
      grant({ id: 6, partyId: 1, exclusivity: "exclusive", regions: [BR], languages: [EN] })
    ]
  });
  assert.equal(at(m, "BR", "pt").state, "conflict");
  assert.deepEqual(at(m, "BR", "pt").conflicts, [[1, 2]]);
  assert.equal(at(m, "US", "en").state, "exclusive", "期間がずれていればぶつからない");
  assert.equal(at(m, "BR", "en").state, "conflict", "相手 2 と相手 1 の独占がぶつかる");
  assert.deepEqual(at(m, "BR", "en").conflicts, [[2, 6]]);
});

test("作者から取った範囲：内で許諾が無ければ空き、外で許諾していれば outside", () => {
  const m = buildRightsMatrix({
    work: { id: 1, title: "作品" }, today: "2026-11-07", includeEnded: false,
    envelope: envelope([JP, US], []),
    grants: [grant({ id: 1, regions: [US], languages: [EN] }), grant({ id: 2, regions: [BR], languages: [PT] })]
  });
  assert.equal(at(m, "US", "en").state, "non_exclusive");
  assert.equal(at(m, "JP", "en").state, "open");
  assert.equal(at(m, "BR", "pt").state, "outside");
  assert.equal(at(m, "__other_region", "en").state, "none", "取った範囲が国の指定なら、その他の地域は取っていない");
  assert.equal(m.counts.outside, 1);
  assert.ok(m.counts.open > 0);
});

test("終わった許諾は出さない（出すときもぶつかりには数えない）。始まる前の許諾は予定", () => {
  const input = {
    work: { id: 1, title: "作品" }, today: "2026-11-07", envelope: null,
    grants: [
      grant({ id: 1, exclusivity: "exclusive" as const, regions: [JP], languages: [JA], termEnd: "2025-12-31" }),
      grant({ id: 2, regions: [JP], languages: [JA], termStart: "2027-04-01", termEnd: null })
    ]
  };
  const live = buildRightsMatrix({ ...input, includeEnded: false });
  assert.deepEqual(live.grants.map((g) => [g.id, g.scheduled]), [[2, true]]);
  const all = buildRightsMatrix({ ...input, includeEnded: true });
  assert.equal(all.grants.length, 2);
  assert.equal(at(all, "JP", "ja").state, "non_exclusive");
  assert.deepEqual(at(all, "JP", "ja").conflicts, []);
});

test("コードの無い移行データは名前で揃え、許諾も取った範囲も無ければ「全世界」「全言語」の 1 マス", () => {
  const m = buildRightsMatrix({
    work: { id: 1, title: "作品" }, today: "2026-11-07", includeEnded: false, envelope: envelope([], []),
    grants: [grant({ id: 1, regions: [{ code: null, label: "北米" }] }), grant({ id: 2, regions: [{ code: null, label: "北米" }] })]
  });
  assert.deepEqual(m.regions.map((r) => r.key), ["name:北米", "__other_region"]);
  assert.deepEqual(m.languages.map((l) => l.label), ["全言語"]);
  assert.equal(at(m, "__other_region", "__other_language").state, "open");
  const empty = buildRightsMatrix({ work: { id: 1, title: "作品" }, today: "2026-11-07", includeEnded: false, envelope: null, grants: [] });
  assert.deepEqual([empty.regions.map((r) => r.label), empty.languages.map((l) => l.label)], [["全世界"], ["全言語"]]);
});
