import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { buildPartyMap, executedChange, planRemap, PartyAgreementMapService, type MapAgreement, type RemapCurrent } from "./party-map.js";

const party = { id: 5, name: "株式会社サンプル" };

function a(over: Partial<MapAgreement> & { id: number }): MapAgreement {
  return {
    agreementNo: `ARC-${over.id}`, title: "契約", kind: "master", domain: "license", direction: "out",
    status: "executed", parentId: null, executedOn: "2025-04-01", terminatedOn: null,
    counterparty: { id: 5, name: party.name, merged: false },
    parentResolvedPartyId: null, parentKind: null, conditionCount: 0, documentCount: 0,
    ...over
  };
}

test("基本契約の下に補助文書・解除合意がぶら下がり、文書だけは別に並ぶ", () => {
  const map = buildPartyMap(party, [
    a({ id: 1 }),
    a({ id: 2, kind: "supplement", parentId: 1, parentResolvedPartyId: 5, parentKind: "master" }),
    a({ id: 3, kind: "termination", parentId: 1, parentResolvedPartyId: 5, parentKind: "master" }),
    a({ id: 4, kind: "document", domain: null })
  ]);
  assert.equal(map.roots.length, 1);
  assert.deepEqual(map.roots[0].children.map((c) => c.id), [2, 3]);
  assert.deepEqual(map.documents.map((d) => d.id), [4]);
  assert.equal(map.issues.length, 0);
  assert.equal(map.roots[0].primary, true);
});

test("親の無い補助文書・別の取引先の親・基本契約でない親は木に入れず、ずれとして出す", () => {
  const map = buildPartyMap(party, [
    a({ id: 1 }),
    a({ id: 2, kind: "supplement" }),
    a({ id: 3, kind: "supplement", parentId: 99, parentResolvedPartyId: 8, parentKind: "master" }),
    a({ id: 4, kind: "supplement", parentId: 2, parentResolvedPartyId: 5, parentKind: "supplement" })
  ]);
  assert.deepEqual(map.loose.map((x) => x.id), [2, 3, 4]);
  assert.deepEqual(map.issues.map((i) => i.code), ["orphan", "parent_party_mismatch", "parent_not_master"]);
});

test("種別の無い基本契約・親を持つ基本契約はずれ", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, domain: null }),
    a({ id: 2, parentId: 1, parentResolvedPartyId: 5, parentKind: "master" })
  ]);
  const codes = map.issues.map((i) => `${i.code}:${i.agreementId}`).sort();
  assert.deepEqual(codes, ["master_with_parent:2", "no_domain:1"]);
});

test("同じ種別・方向の生きた基本契約が2本あれば、新しい方を既定にして古い方をずれに出す", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, executedOn: "2020-04-01" }),
    a({ id: 2, executedOn: "2024-04-01" }),
    // 解除済みと別方向は数えない
    a({ id: 3, executedOn: "2025-01-01", terminatedOn: "2025-06-30" }),
    a({ id: 4, direction: "in" })
  ]);
  const primary = map.roots.filter((r) => r.primary).map((r) => r.id).sort();
  assert.deepEqual(primary, [2, 4]);
  assert.deepEqual(map.issues.map((i) => `${i.code}:${i.agreementId}`), ["duplicate_master:1"]);
});

test("既定は基本契約だけ。単体契約しか無ければ既定なし。未締結も既定にしない", () => {
  const onlyStandalone = buildPartyMap(party, [
    a({ id: 1, status: "negotiating" }),
    a({ id: 2, kind: "standalone" })
  ]);
  assert.deepEqual(onlyStandalone.roots.filter((r) => r.primary).map((r) => r.id), []);
  const both = buildPartyMap(party, [a({ id: 1 }), a({ id: 2, kind: "standalone", executedOn: "2025-01-01" })]);
  assert.deepEqual(both.roots.filter((r) => r.primary).map((r) => r.id), [1], "新しい単体契約より基本契約");
});

const current: RemapCurrent = {
  id: 10, kind: "supplement", domain: "license", direction: "out", parentId: null,
  counterpartyId: 5, resolvedPartyId: 5, childCount: 0
};

test("付け替え：親の無い補助文書に、同じ取引先の基本契約を親として付ける", () => {
  const next = planRemap(current, { parentId: 1 }, { id: 1, kind: "master", resolvedPartyId: 5 }, 5);
  assert.equal(next.parentId, 1);
  assert.equal(next.kind, "supplement");
});

test("付け替え：基本契約に変えると親は外れ、種別が要る", () => {
  assert.throws(() => planRemap({ ...current, domain: null }, { kind: "master" }, null, 5), /種別/);
  const next = planRemap({ ...current, parentId: 1 }, { kind: "master", domain: "service" }, null, 5);
  assert.equal(next.parentId, null);
  assert.equal(next.domain, "service");
});

test("付け替え：通らない形を断る", () => {
  assert.throws(() => planRemap(current, {}, null, 5), /親の契約を選んで/);
  assert.throws(() => planRemap(current, { parentId: 10 }, null, 5), /自分自身/);
  assert.throws(() => planRemap(current, { parentId: 1 }, { id: 1, kind: "supplement", resolvedPartyId: 5 }, 5),
                /基本契約か単体契約だけ/);
  assert.throws(() => planRemap(current, { parentId: 1 }, { id: 1, kind: "master", resolvedPartyId: 8 }, 5),
                /相手先が違います/);
  const root: RemapCurrent = { ...current, kind: "master", childCount: 2 };
  assert.throws(() => planRemap(root, { kind: "document" }, null, 5), /ぶら下がっています/);
  assert.throws(() => planRemap(root, { counterpartyId: 8 }, null, 8), /相手先は変えられません/);
});

test("取引先のマップは統合先で引き、件数の上限を付けない", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 5, resolved_name: "株式会社サンプル" }];
    if (t.includes("FROM agreements a")) return [
      { id: 1, agreement_no: "ARC-LIC-2025-0001", title: "基本", kind: null, domain: "license", direction: "out",
        status: "executed", parent_id: null, counterparty_id: 3, party_name: "旧サンプル", party_merged: true }
    ];
    return [];
  });
  const map = await new PartyAgreementMapService(db).forParty(3);
  assert.equal(map?.party.id, 5);
  assert.equal(map?.roots[0].kind, "master", "kind が空の移行行は基本契約とみなす");
  assert.equal(map?.roots[0].counterparty.merged, true);
  const q = db.find("WHERE r.resolved_id = $1")!;
  assert.deepEqual(q.params, [5]);
  assert.ok(!q.text.includes("LIMIT"));
});

test("付け替えは agreements の列を書き、前後を監査に残す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 10, kind: "supplement", domain: "license", direction: "out",
                                               parent_id: null, counterparty_id: 5, resolved_id: 5, child_count: 0 }];
    if (t.includes("SELECT a.id, a.kind, r.resolved_id")) return [{ id: 1, kind: "master", resolved_id: 5 }];
    return [];
  });
  await new PartyAgreementMapService(db).remap(10, { parentId: 1 }, "legal@example.test");
  const up = db.find("UPDATE agreements")!;
  assert.deepEqual(up.params.slice(0, 6), [10, "supplement", "license", "out", 1, 5]);
  assert.ok(db.queries.some((q) => q.params.includes("agreement.remap")));
});

test("締結日：未締結に入れたら締結済みにする。締結済み・解除済みは状態を変えない", () => {
  assert.deepEqual(executedChange("negotiating", "2024-04-01"), { executedOn: "2024-04-01", status: "executed" });
  assert.deepEqual(executedChange("draft", "2024-04-01"), { executedOn: "2024-04-01", status: "executed" });
  assert.deepEqual(executedChange("executed", "2024-05-01"), { executedOn: "2024-05-01", status: "executed" });
  assert.deepEqual(executedChange("terminated", "2024-05-01"), { executedOn: "2024-05-01", status: "terminated" });
  assert.deepEqual(executedChange("negotiating", null), { executedOn: null, status: "negotiating" });
  assert.throws(() => executedChange("draft", "2024/04/01"), /YYYY-MM-DD/);
});

test("締結日は付け替えと一緒に保存し、監査に前後を残す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 1, kind: "master", domain: "license", direction: "out",
                                               parent_id: null, counterparty_id: 5, resolved_id: 5, child_count: 0,
                                               status: "negotiating", executed_on: null }];
    return [];
  });
  await new PartyAgreementMapService(db).remap(1, { executedOn: "2024-04-01" }, "legal@example.test");
  const up = db.find("SET executed_on")!;
  assert.deepEqual(up.params, [1, "2024-04-01", "executed"]);
  assert.match(up.text, /effective_on = COALESCE\(effective_on/);
});

test("文書フォームの選択肢：基本契約は締結日付きの呼び方、文書は発注書と個別契約に分ける", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 5, resolved_name: "株式会社サンプル" }];
    if (t.includes("FROM agreements a")) return [
      { id: 1, agreement_no: "ARC-LIC-2024-0012", title: "利用許諾基本契約", kind: "master", domain: "license",
        direction: "out", status: "executed", executed_on: "2024-04-01", parent_id: null, counterparty_id: 5, party_name: "株式会社サンプル" },
      { id: 2, agreement_no: "ARC-LIC-2024-0012-S01", title: "覚書", kind: "supplement", domain: "license",
        direction: "out", status: "executed", parent_id: 1, parent_resolved_id: 5, parent_kind: "master",
        counterparty_id: 5, party_name: "株式会社サンプル" }
    ];
    if (t.includes("FROM documents d")) return [
      { id: 10, document_no: "ARC-PO-2026-0032", title: "挿絵", template_key: "purchase_order", label: "発注書", issued_at: "2026-08-01" },
      { id: 11, document_no: "ARC-ILT-D-2026-0001", title: "作品A", template_key: "individual_license_terms_v3", label: "個別利用許諾条件書" }
    ];
    return [];
  });
  const refs = (await new PartyAgreementMapService(db).documentRefs(5))!;
  assert.deepEqual(refs.masters.map((m) => m.datedTitle), ["2024年4月1日付利用許諾基本契約"], "補助文書は基本契約の候補に出さない");
  assert.equal(refs.masters[0].primary, true);
  assert.deepEqual(refs.purchaseOrders.map((d) => d.documentNo), ["ARC-PO-2026-0032"]);
  assert.deepEqual(refs.terms.map((d) => d.documentNo), ["ARC-ILT-D-2026-0001"]);
  assert.deepEqual(db.find("FROM documents d")!.params[0], 5, "統合先で引く");
});

test("文書フォームの選択肢：条件を渡すと、その条件につながっている発注書（単体契約・文書）も返す", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 5, resolved_name: "タンサン" }];
    if (t.includes("WITH wanted AS")) return [
      { source: "agreement", id: 100, no: "ARC-PO-2026-0079", title: "TANSAN 発注書", issued_on: "2026-06-23",
        condition_nos: ["CL-2026-00768", "CL-2026-00770"] },
      { source: "document", id: 501, no: "ARC-PO-2026-0079", title: "重複", issued_on: null, condition_nos: [] }
    ];
    return [];
  });
  const svc = new PartyAgreementMapService(db);
  const refs = (await svc.documentRefs(5, [768, 770]))!;
  assert.deepEqual(refs.linkedOrders.map((d) => [d.documentNo, d.source, d.conditionNos]),
    [["ARC-PO-2026-0079", "agreement", ["CL-2026-00768", "CL-2026-00770"]]], "同じ番号は 1 つ");
  assert.deepEqual(db.find("WITH wanted AS")!.params[0], [768, 770]);
  assert.match(db.find("WITH wanted AS")!.text, /'standalone', 'document'/, "基本契約の番号は出さない");
  const none = (await svc.documentRefs(5))!;
  assert.deepEqual(none.linkedOrders, []);
});

test("何も変わらなければ書かない。試算は書いてから巻き戻す", async () => {
  const row = { id: 1, kind: "master", domain: "license", direction: "out", parent_id: null, counterparty_id: 5,
                resolved_id: 5, child_count: 0, status: "executed", executed_on: "2024-04-01",
                title: "利用許諾基本契約", effective_on: "2024-04-01", expires_on: null,
                auto_renewal: true, counterparty_ref_no: null };
  const db = new FakeDatabase((t) => (t.includes("FOR UPDATE OF a") ? [row] : []));
  const svc = new PartyAgreementMapService(db);
  assert.deepEqual(await svc.remap(1, { title: "利用許諾基本契約", executedOn: "2024-04-01", autoRenewal: true }, "who"), []);
  assert.equal(db.find("UPDATE agreements"), undefined);

  const changed = await svc.remap(1, { title: "利用許諾基本契約（改）", expiresOn: "2029-03-31" }, "who", { dryRun: true });
  assert.deepEqual(changed, ["件名", "終了日"]);
  assert.ok(db.find("UPDATE agreements"), "検証のため書く");
  assert.equal(db.texts.at(-1), "ROLLBACK", "試算は巻き戻す");
});

test("取引先の一覧：名称・コード・カナ・別名で探し、統合先で出す。契約の無い取引先も未紐づけの数を持つ", async () => {
  const db = new FakeDatabase((t) => t.includes("WITH matched AS") ? [
    { party_id: 7, name: "石野謙介", total: 0, roots: 0, documents: 0, issues: 0, unlinked: 2, loose_conditions: 3 }
  ] : []);
  const rows = await new PartyAgreementMapService(db).parties({ keyword: "イシノ" });
  assert.deepEqual(rows, [{ id: 7, name: "石野謙介", total: 0, roots: 0, documents: 0, issues: 0, unlinked: 2, looseConditions: 3 }]);
  const q = db.find("WITH matched AS")!;
  assert.equal(q.params[0], "%イシノ%");
  for (const col of ["p.name ILIKE", "party_code", "name_kana", "unnest(p.aliases)"]) assert.ok(q.text.includes(col), col);
  assert.ok(q.text.includes("d.agreement_id IS NULL"), "契約に繋がっていない文書を数える");
  assert.ok(q.text.includes("'purchase_order'") && q.text.includes("'royalty_statement'"), "発注書・計算書は数えない");
});

test("取引先の一覧：契約に載っていない条件明細を数え、それだけの取引先も出す", async () => {
  const db = new FakeDatabase((t) => t.includes("WITH matched AS") ? [] : []);
  await new PartyAgreementMapService(db).parties({});
  const q = db.find("WITH matched AS")!;
  assert.ok(q.text.includes("co.status NOT IN ('superseded', 'void')"), "取り消し・差し替え済みは数えない");
  assert.ok(q.text.includes("co.agreement_id IS NULL"), "契約に載っていない条件");
  assert.ok(q.text.includes("COALESCE(kind, 'master') = 'master'"), "基本契約に直接載っている条件も（基本契約は条件を持たない）");
  assert.ok(q.text.includes("NOT EXISTS") && q.text.includes("hdc.condition_id = co.id"), "発注書・条件書に載っている条件は数えない");
  assert.ok(q.text.includes("OR COALESCE(lc.loose_conditions, 0) > 0)"), "条件だけの取引先も一覧に出す");
});

test("取引先のマップに、契約に載っていない条件明細を並べる（統合先で引く）", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 7, resolved_name: "石野謙介" }];
    if (t.includes("FROM conditions co")) return [
      { id: 31, condition_no: "CL-2026-00331", name: "ito｜自社製造・自社販売", kind: "license", direction: "in",
        status: "active", term_start: "2026-10-01", work_title: "ito" }
    ];
    return [];
  });
  const map = (await new PartyAgreementMapService(db).forParty(7))!;
  assert.deepEqual(map.looseConditions, [{ id: 31, conditionNo: "CL-2026-00331", name: "ito｜自社製造・自社販売",
    kind: "license", direction: "in", status: "active", workTitle: "ito", termStart: "2026-10-01", masterNo: null }]);
  const q = db.find("FROM conditions co")!;
  assert.deepEqual(q.params, [7]);
  assert.ok(q.text.includes("r.resolved_id = $1"), "統合元の取引先に付いた条件も拾う");
});

test("取引先のマップに、契約に繋がっていない契約文書を並べる", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("SELECT resolved_id, resolved_name FROM v_party_resolved")) return [{ resolved_id: 7, resolved_name: "石野謙介" }];
    if (t.includes("FROM agreements a")) return [];
    if (t.includes("d.agreement_id IS NULL")) return [
      { id: 50, document_no: "LIC-2025-0007", status: "issued", issued_at: "2025-07-31", title: null,
        manual_title: "利用許諾契約書（おたずねマもの村）", label: "利用許諾契約書", role: "terms", condition_count: 2 }
    ];
    return [];
  });
  const map = (await new PartyAgreementMapService(db).forParty(7))!;
  assert.equal(map.roots.length, 0);
  assert.deepEqual(map.unlinked, [{ id: 50, documentNo: "LIC-2025-0007", label: "利用許諾契約書",
    title: "利用許諾契約書（おたずねマもの村）", status: "issued", issuedOn: "2025-07-31", role: "terms", conditionCount: 2 }]);
  assert.deepEqual(db.find("d.agreement_id IS NULL")!.params, [7]);
});

test("条件明細の載った単体契約があり、同じ向きの基本契約もあれば「個別契約にできる」と出す", () => {
  const map = buildPartyMap(party, [
    a({ id: 1, direction: "in" }),
    a({ id: 2, kind: "standalone", direction: "in", conditionCount: 3 }),
    a({ id: 3, kind: "standalone", direction: "in", conditionCount: 0 }),
    a({ id: 4, kind: "standalone", direction: "out", conditionCount: 2 })
  ]);
  assert.deepEqual(map.issues.filter((i) => i.code === "standalone_with_master").map((i) => i.agreementId), [2],
    "条件の無い単体契約・向きの違う単体契約は出さない");
  assert.match(map.issues.find((i) => i.agreementId === 2)!.message, /ARC-1（基本契約）/);
});

test("個別契約にする：単体契約以外・向き違い・別の取引先は断る", async () => {
  const db = (agreement: Record<string, unknown>, master: Record<string, unknown>) => new FakeDatabase((t, p) => {
    if (t.includes("FOR UPDATE OF a")) return [{ id: 2, agreement_no: "ARC-ILT-1", kind: "standalone", direction: "in",
      domain: "license", resolved_id: 5, child_count: 0, ...agreement }];
    if (t.includes("terminated_on, r.resolved_id")) return [{ id: 1, agreement_no: "ARC-LIC-1", kind: "master",
      direction: "in", domain: "license", terminated_on: null, resolved_id: 5, ...master }];
    if (t.includes("UPDATE conditions")) return [{ id: 10 }, { id: 11 }];
    return [];
  });
  const ok = db({}, {});
  assert.deepEqual(await new PartyAgreementMapService(ok).demoteToIndividual(2, 1, "k"),
    { conditionsMoved: 2, masterId: 1, masterNo: "ARC-LIC-1", masterCreated: false });
  assert.deepEqual(ok.find("SET kind = 'supplement'")!.params, [2, 1, "license"]);
  assert.deepEqual(ok.find("UPDATE conditions")!.params, [2, 1], "条件明細は基本契約へ");
  await assert.rejects(() => new PartyAgreementMapService(db({ kind: "master" }, {})).demoteToIndividual(2, 1, "k"), /単体契約だけ/);
  await assert.rejects(() => new PartyAgreementMapService(db({}, { direction: "out" })).demoteToIndividual(2, 1, "k"), /向き/);
  await assert.rejects(() => new PartyAgreementMapService(db({}, { resolved_id: 9 })).demoteToIndividual(2, 1, "k"), /相手先/);
  await assert.rejects(() => new PartyAgreementMapService(db({ child_count: 1 }, {})).demoteToIndividual(2, 1, "k"), /覚書・解除合意/);
});

test("文書から契約を立てる：基本契約書・条件書でない文書、繋がっている文書は断る", async () => {
  const db = (row: Record<string, unknown>) => new FakeDatabase((t) => t.includes("FOR UPDATE OF d") ? [{
    id: 1, document_no: "ARC-NDA-1", status: "issued", agreement_id: null, counterparty_id: 7, resolved_id: 7,
    label: "NDA", role: null, ...row }] : []);
  await assert.rejects(() => new PartyAgreementMapService(db({})).agreementFromDocument(1, "k"), /基本契約書・条件書でない/);
  await assert.rejects(() => new PartyAgreementMapService(db({ agreement_id: 3 })).agreementFromDocument(1, "k"), /既に契約/);
  await assert.rejects(() => new PartyAgreementMapService(db({ role: "master", status: "draft" })).agreementFromDocument(1, "k"), /決定済み/);
});

test("発注書が契約（単体契約・文書だけ）として登録されていれば、文書に寄せるよう知らせる", async () => {
  const { isOrderAgreement } = await import("./party-map.js");
  assert.equal(isOrderAgreement({ kind: "standalone", agreementNo: "ARC-PO-2026-0079", title: "x" }), true);
  assert.equal(isOrderAgreement({ kind: "document", agreementNo: "X-1", title: "【文書作成】TANSAN株式会社_発注書_20260623" }), true);
  assert.equal(isOrderAgreement({ kind: "master", agreementNo: "ARC-PO-1", title: "発注書" }), false, "基本契約は対象外");
  assert.equal(isOrderAgreement({ kind: "standalone", agreementNo: "ARC-ILT-2026-0036", title: "個別利用許諾条件書" }), false);
  const map = buildPartyMap(party, [a({ id: 9, kind: "standalone", agreementNo: "ARC-PO-2026-0079", conditionCount: 2 })]);
  assert.deepEqual(map.issues.map((i) => i.code), ["order_as_agreement"]);
});

test("発注書を紐づける：取り込んだ文書は発注書にし、契約に載っていない条件は基本契約へ。相手先が混ざれば断る", async () => {
  const db = (over: Record<string, unknown> = {}, parties = [5]) => new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF d")) return [{ id: 513, document_no: "ARC-SVC-2026-0013", status: "issued",
      template_version_id: null, template_key: null, kind: null, ...over }];
    if (t.includes("JOIN v_party_resolved r ON r.party_id = c.counterparty_id")) return parties.map((p, i) => ({ id: 769 + i, direction: "in", agreement_id: null, resolved_id: p }));
    if (t.includes("FROM document_conditions dc JOIN conditions c")) return [{ id: 769, direction: "in", agreement_id: null }];
    if (t.includes("COALESCE(a.kind, 'master') = 'master'")) return [{ id: 90, agreement_no: "ARC-SVC-2026-0001" }];
    return [];
  });
  const ok = db();
  assert.deepEqual(await new PartyAgreementMapService(ok).linkOrder(513, [769], "k"),
    { linked: 1, masterNo: "ARC-SVC-2026-0001", documentNo: "ARC-SVC-2026-0013" });
  assert.match(ok.find("SET manual_inputs")!.text, /"documentKind":"発注書"/, "取り込んだ文書を発注書にする");
  assert.deepEqual(ok.find("UPDATE conditions SET agreement_id")!.params, [[769], 90]);
  await assert.rejects(() => new PartyAgreementMapService(db({ template_key: "inspection_certificate", template_version_id: 3 })).linkOrder(1, [769], "k"), /発注書でない/);
  await assert.rejects(() => new PartyAgreementMapService(db({}, [5, 6])).linkOrder(513, [769, 770], "k"), /相手先の違う/);
});

test("発注書を紐づける：基本契約を選べば、その発注書の条件（契約なし・基本契約に載るもの）をそろえる。null は基本契約なし", async () => {
  const db = (master: Record<string, unknown> | null) => new FakeDatabase((t) => {
    if (t.includes("FOR UPDATE OF d")) return [{ id: 97, document_no: "ARC-PO-2026-0097", status: "issued",
      template_version_id: null, template_key: null, kind: "発注書" }];
    if (t.includes("JOIN v_party_resolved r ON r.party_id = c.counterparty_id")) return [{ id: 175, direction: "in", agreement_id: null, resolved_id: 5 }];
    if (t.includes("SELECT DISTINCT r.resolved_id")) return [{ resolved_id: 5 }];
    if (t.includes("LEFT JOIN agreements a ON a.id = c.agreement_id")) return [
      { id: 175, direction: "in", agreement_id: null, agreement_kind: "master" },
      { id: 344, direction: "in", agreement_id: 9, agreement_kind: "standalone" }];
    if (t.includes("WHERE a.id = $1")) return master ? [master] : [];
    return [];
  });
  const d1 = db({ id: 14, agreement_no: "ARC-SVC-2026-0014", direction: "in", kind: "master", resolved_id: 5 });
  const r = await new PartyAgreementMapService(d1).linkOrder(97, [175], "k", { masterId: 14 });
  assert.equal(r.masterNo, "ARC-SVC-2026-0014");
  assert.deepEqual(d1.find("UPDATE conditions SET agreement_id")!.params, [[175], 14], "単体契約に載る条件は動かさない");
  const d2 = db(null);
  await new PartyAgreementMapService(d2).linkOrder(97, [175], "k", { masterId: null });
  assert.deepEqual(d2.find("UPDATE conditions SET agreement_id")!.params, [[175], null]);
  await assert.rejects(() => new PartyAgreementMapService(db({ id: 3, kind: "standalone", resolved_id: 5 })).linkOrder(97, [175], "k", { masterId: 3 }), /基本契約を選んで/);
});
