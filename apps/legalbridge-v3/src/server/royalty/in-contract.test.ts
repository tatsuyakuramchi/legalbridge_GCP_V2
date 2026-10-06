import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { inContractRef, inContractRefText, withInContract } from "./in-contract.js";
import { usageBundleLines } from "../documents/royalty-patch.js";

test("対象契約：イン側の基本契約・個別契約を締結日付きで並べる。契約番号は個別契約の番号（無ければ基本契約）", () => {
  const master = { no: "ARC-LIC-2024-0012", title: "利用許諾基本契約", on: "2024-04-01" };
  const terms = { no: "ARC-ILT-D-2026-0001", title: "個別利用許諾条件書", on: "2025-06-01" };
  assert.deepEqual(inContractRefText(master, terms), {
    title: "2024年4月1日付利用許諾基本契約 / 2025年6月1日付個別利用許諾条件書",
    number: "ARC-ILT-D-2026-0001"
  });
  assert.deepEqual(inContractRefText(null, terms),
                   { title: "2025年6月1日付個別利用許諾条件書", number: "ARC-ILT-D-2026-0001" });
  assert.deepEqual(inContractRefText(master, null),
                   { title: "2024年4月1日付利用許諾基本契約", number: "ARC-LIC-2024-0012" });
  assert.deepEqual(inContractRefText(null, null), { title: "", number: "" });
});

test("行のアウト側の契約（許諾先の取引先名・条件名・番号）を、イン側の契約に置き換える", () => {
  const lines = usageBundleLines([
    { eventId: 1, productName: "作品A", methodLabel: "再許諾（受領価格）", basis: 1_000_000, ratePct: 20, amount: 200_000,
      outPartyName: "Korea Board games Co., Ltd.", outConditionName: "韓国語版", outAgreementNo: "ARC-LIC-OUT-9" }
  ]);
  assert.match(lines[0].contractTitle, /Korea/, "置き換え前はアウト側");
  const out = withInContract(lines, { title: "2024年4月1日付利用許諾基本契約", number: "ARC-LIC-2024-0012" });
  assert.equal(out[0].contractTitle, "2024年4月1日付利用許諾基本契約");
  assert.equal(out[0].contractNumber, "ARC-LIC-2024-0012");
  assert.equal(out[0].payerName, "Korea Board games Co., Ltd.", "取引モデル概要（◯◯再許諾分）の材料は残す");
});

const fake = (agreement: Record<string, unknown>, docs: Array<Record<string, unknown>> = []) =>
  new FakeDatabase((t) => {
    if (t.includes("FROM conditions c\n       LEFT JOIN agreements a")) return [{ id: 7, direction: "in", counterparty_id: 5, ...agreement }];
    if (t.includes("FROM documents d")) return docs;
    if (t.includes("SELECT executed_on FROM agreements")) return [{ executed_on: "2025-07-31" }];
    return [];
  });

test("単体契約に載った条件で条件書が無ければ、その単体契約を個別契約として出す（契約未指定にしない）", async () => {
  const db = fake({ a_id: 3, a_no: "ARC-ILT-2026-0037", a_title: "利用許諾契約書", a_kind: "standalone", a_status: "executed" });
  assert.deepEqual(await inContractRef(db, 7),
                   { title: "2025年7月31日付利用許諾契約書", number: "ARC-ILT-2026-0037" });
});

test("条件書が繋がっていれば、個別契約は条件書を優先する", async () => {
  const db = fake({ a_id: 3, a_no: "ARC-ILT-2026-0037", a_title: "利用許諾契約書", a_kind: "standalone", a_status: "executed" },
    [{ id: 9, document_no: "ARC-ILT-D-2026-0001", status: "issued", issued_at: "2025-06-01", label: "個別利用許諾条件書" }]);
  assert.deepEqual(await inContractRef(db, 7),
                   { title: "2025年6月1日付個別利用許諾条件書", number: "ARC-ILT-D-2026-0001" });
});

test("補助文書に載った条件：基本契約（親）/ 補助文書", async () => {
  const db = fake({ a_id: 4, a_no: "ARC-LIC-2024-0012-S01", a_title: "覚書", a_kind: "supplement", a_status: "executed",
                    p_id: 1, p_no: "ARC-LIC-2024-0012", p_title: "利用許諾基本契約", p_kind: "master", p_status: "executed" });
  const ref = await inContractRef(db, 7);
  assert.equal(ref.number, "ARC-LIC-2024-0012-S01", "契約番号は条件に付いた覚書（個別）の番号");
  assert.equal(ref.title, "2025年7月31日付利用許諾基本契約 / 2025年7月31日付覚書");
});

test("基本契約に直接載った条件で条件書が無ければ基本契約だけ", async () => {
  const db = fake({ a_id: 1, a_no: "ARC-LIC-2024-0012", a_title: "利用許諾基本契約", a_kind: "master", a_status: "executed" });
  assert.deepEqual(await inContractRef(db, 7),
                   { title: "2025年7月31日付利用許諾基本契約", number: "ARC-LIC-2024-0012" });
});

test("文書フォームで選んだ個別契約番号を使う", async () => {
  const db = fake({ a_id: 3, a_no: "ARC-ILT-2026-0037", a_title: "利用許諾契約書", a_kind: "standalone", a_status: "executed" });
  assert.equal((await inContractRef(db, 7, { termsNo: "IMP-2025-0007" })).number, "IMP-2025-0007");
});
