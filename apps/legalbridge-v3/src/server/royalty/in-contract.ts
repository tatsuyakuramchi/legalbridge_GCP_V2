import { dateStr, type Queryable } from "../core/db.js";
import { conditionContracts, contractRefText } from "../conditions/contracts.js";
import { agreementDatedTitle } from "../documents/legacy-variables.js";
import type { BundleLine } from "../documents/royalty-patch.js";

/**
 * 計算書の「契約番号」と明細の「対象契約」に出す、イン側（デザイナー・権利者との）契約。
 *
 * 計算書は作者（権利者）に払う書類で、読むのは作者。アウト側（許諾先との）契約は
 * 作者が結んでいない契約なので、名前も番号も出さない。
 *
 *   対象契約  2024年4月1日付利用許諾基本契約 / 2025年7月31日付利用許諾契約書
 *   契約番号  ARC-LIC-2024-0012 / ARC-ILT-2026-0037
 *
 * 基本契約 … 条件が載っている契約が基本契約ならそれ、補助文書なら親の基本契約。
 *            単体契約は基本契約ではない（個別の側に出す）。
 * 個別契約 … 条件に繋がった決定済みの条件書（取り込んだ利用許諾契約書・覚書を含む）。
 *            無ければ、条件が載っている基本契約以外の契約（単体契約・補助文書）。
 *            文書フォームで個別契約番号を選んでいればそれ。
 * 片方しか無ければ片方だけ。
 */
export interface InContractRef { title: string; number: string }

interface Part { no: string | null; title: string; on: string | null }

export function inContractRefText(master: Part | null, individual: Part | null): InContractRef {
  const title = [
    master ? agreementDatedTitle(master.title, master.on) : undefined,
    individual ? agreementDatedTitle(individual.title, individual.on) : undefined
  ].filter(Boolean).join(" / ");
  return { title, number: contractRefText(master?.no, individual?.no) };
}

export async function inContractRef(
  client: Queryable, conditionId: number,
  options: {
    /** 文書フォームで選んだ基本契約（agreement の id）。条件の契約より優先。 */
    masterAgreementId?: number | null;
    /** 文書フォームで選んだ個別契約番号（文書番号）。 */
    termsNo?: string | null;
  } = {}
): Promise<InContractRef> {
  const cc = await conditionContracts(client, conditionId);
  const executedOn = async (id: number) => dateStr(((await client.query(
    "SELECT executed_on FROM agreements WHERE id = $1", [id])).rows[0] as { executed_on?: unknown } | undefined)?.executed_on);

  // 基本契約。選んであればそれ（基本契約のときだけ）、無ければ条件の基本契約。
  let master: Part | null = null;
  if (options.masterAgreementId) {
    const r = (await client.query(
      `SELECT a.agreement_no, a.title, a.executed_on, a.kind, p.agreement_no AS p_no, p.title AS p_title,
              p.executed_on AS p_executed_on, p.kind AS p_kind
         FROM agreements a LEFT JOIN agreements p ON p.id = a.parent_id WHERE a.id = $1`,
      [options.masterAgreementId])).rows[0] as Record<string, any> | undefined;
    const kind = String(r?.kind ?? "master");
    if (r && kind === "master") master = { no: r.agreement_no ?? null, title: String(r.title ?? ""), on: dateStr(r.executed_on) };
    else if (r && (kind === "supplement" || kind === "termination") && String(r.p_kind ?? "master") === "master" && r.p_title) {
      master = { no: r.p_no ?? null, title: String(r.p_title), on: dateStr(r.p_executed_on) };
    }
  } else if (cc.master && cc.master.kind === "master") {
    master = { no: cc.master.no, title: cc.master.title, on: await executedOn(cc.master.id) };
  }

  // 個別契約。選んだ番号 → 決定済みの条件書 → 条件が載っている基本契約以外の契約。
  let individual: Part | null = null;
  const chosen = options.termsNo?.trim();
  const terms = chosen
    ? cc.terms.find((t) => t.no === chosen) ?? null
    : cc.terms.find((t) => t.used) ?? null;
  if (terms) individual = { no: terms.no, title: terms.label, on: terms.issuedOn };
  else if (chosen) individual = { no: chosen, title: "", on: null };
  else if (cc.agreement && cc.agreement.kind !== "master" && cc.agreement.kind !== "document") {
    individual = { no: cc.agreement.no, title: cc.agreement.title, on: await executedOn(cc.agreement.id) };
  }
  return inContractRefText(master, individual);
}

/** 行の「対象契約」「契約番号」をイン側の契約に置き換える。人が直した見出しはこのあと重ねる。 */
export function withInContract(lines: BundleLine[], ref: InContractRef): BundleLine[] {
  return lines.map((line) => ({ ...line, contractTitle: ref.title, contractNumber: ref.number }));
}
