import test from "node:test";
import assert from "node:assert/strict";
import { FakeDatabase } from "../core/fake-db.js";
import { inContractRef, inContractRefText, withInContract } from "./in-contract.js";
import { usageBundleLines } from "../documents/royalty-patch.js";

test("対象契約：イン側の基本契約・個別契約を締結日付きで並べる。片方だけならそれだけ", () => {
  const master = { no: "ARC-LIC-2024-0012", title: "利用許諾基本契約", executedOn: "2024-04-01" };
  const terms = { no: "ARC-ILT-D-2026-0001", label: "個別利用許諾条件書", issuedOn: "2025-06-01" };
  assert.deepEqual(inContractRefText(master, terms), {
    title: "2024年4月1日付利用許諾基本契約 / 2025年6月1日付個別利用許諾条件書",
    number: "ARC-LIC-2024-0012 / ARC-ILT-D-2026-0001"
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

test("イン条件が単体契約に載っていれば基本契約は出さず、条件書だけ", async () => {
  const db = new FakeDatabase((t) => {
    if (t.includes("FROM conditions c\n       LEFT JOIN agreements a")) return [{
      id: 7, direction: "in", counterparty_id: 5,
      a_id: 3, a_no: "ARC-ILT-2026-0037", a_title: "利用許諾契約書", a_kind: "standalone", a_status: "executed"
    }];
    if (t.includes("FROM documents d")) return [{
      id: 9, document_no: "ARC-ILT-D-2026-0001", status: "issued", issued_at: "2025-06-01", label: "個別利用許諾条件書"
    }];
    return [];
  });
  assert.deepEqual(await inContractRef(db, 7),
                   { title: "2025年6月1日付個別利用許諾条件書", number: "ARC-ILT-D-2026-0001" });
});
