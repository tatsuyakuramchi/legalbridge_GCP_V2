import { dateStr, type Queryable } from "../core/db.js";
import { conditionContracts, contractRefText } from "../conditions/contracts.js";
import { agreementDatedTitle } from "../documents/legacy-variables.js";
import type { BundleLine } from "../documents/royalty-patch.js";

/**
 * 計算書の明細の「対象契約」「契約番号」に出す、イン側（デザイナー・権利者との）契約。
 *
 * 計算書は作者（権利者）に払う書類で、読むのは作者。アウト側（許諾先との）契約は
 * 作者が結んでいない契約なので、名前も番号も出さない（以前はアウト条件の
 * 取引先名・条件名・番号を出していた）。どの許諾先の分かは「取引モデル概要」と
 * 行の但し書き（許諾地域など）で分かる。
 *
 *   対象契約  2024年4月1日付利用許諾基本契約 / 2025年6月1日付個別利用許諾条件書
 *   契約番号  ARC-LIC-2024-0012 / ARC-ILT-D-2026-0001
 *
 * 基本契約は基本契約だけ（単体契約は出さない。補助文書に載っていれば親の基本契約）。
 * 個別契約は条件に繋がった決定済みの条件書（取り込んだ利用許諾契約書・覚書を含む）。
 * 片方しか無ければ片方だけ。
 */
export interface InContractRef { title: string; number: string }

export function inContractRefText(
  master: { no: string | null; title: string; executedOn: string | null } | null,
  terms: { no: string | null; label: string; issuedOn: string | null } | null
): InContractRef {
  const title = [
    master ? agreementDatedTitle(master.title, master.executedOn) : undefined,
    terms ? agreementDatedTitle(terms.label, terms.issuedOn) : undefined
  ].filter(Boolean).join(" / ");
  return { title, number: contractRefText(master?.no, terms?.no) };
}

export async function inContractRef(client: Queryable, conditionId: number): Promise<InContractRef> {
  const cc = await conditionContracts(client, conditionId);
  // conditionContracts の master は単体契約も含む。計算書の基本契約は基本契約だけ。
  const master = cc.master && cc.master.kind === "master" ? cc.master : null;
  let executedOn: string | null = null;
  if (master) {
    const r = await client.query("SELECT executed_on FROM agreements WHERE id = $1", [master.id]);
    executedOn = dateStr((r.rows[0] as { executed_on?: unknown } | undefined)?.executed_on);
  }
  const terms = cc.terms.find((t) => t.used) ?? null;
  return inContractRefText(
    master ? { no: master.no, title: master.title, executedOn } : null,
    terms ? { no: terms.no, label: terms.label, issuedOn: terms.issuedOn } : null);
}

/** 行の「対象契約」「契約番号」をイン側の契約に置き換える。人が直した見出しはこのあと重ねる。 */
export function withInContract(lines: BundleLine[], ref: InContractRef): BundleLine[] {
  return lines.map((line) => ({ ...line, contractTitle: ref.title, contractNumber: ref.number }));
}
