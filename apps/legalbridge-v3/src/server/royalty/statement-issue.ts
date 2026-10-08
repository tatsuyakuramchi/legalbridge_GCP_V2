import type { Queryable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { applyLineLabels, stageNotesOf, type BundleLine } from "../documents/royalty-patch.js";
import type { DocumentIssueService } from "../documents/issue-service.js";
import { bundleLinesFor, bundleTotals, type BundleTotals } from "./bundle.js";
import { inContractRef, withInContract } from "./in-contract.js";
import type { CalculationInput, CalculationPreview, RoyaltyStatementService } from "./statement-service.js";

/**
 * 計算書を 1 枚出す（試算 → 行を焼き付けた下書き → 決定 → 計算書を結ぶ）。
 *
 * 入口が 3 つある：文書作成フォーム（/statement-documents）、条件の画面、支払文書処理の
 * 「まとめて締める」。まとめて締めるは検収書の道（実績の額をそのまま支払にする）を
 * 通っていたので、料率の計算書では報告売上がそのまま支払になり、本文にも金額が
 * 載らなかった。ここに寄せて、どの入口からでも同じ紙・同じ支払になるようにする。
 *
 * 出版（紙・電子）の条件だけの計算書は、出版専用のひな形（royalty_statement_pub。
 * 本文に作品ごとの要約、別紙に報告月・書店ごとの明細）で出す。ひな形がまだ登録されて
 * いなければ従来の計算書で出す。
 */

export const STATEMENT_KEY = "royalty_statement";
export const PUB_STATEMENT_KEY = "royalty_statement_pub";
const PUB_USAGES = new Set(["pub_print", "pub_digital"]);

export type StatementEntry = CalculationInput;

export interface IssueStatementInput {
  templateKey?: string | null;
  entries: StatementEntry[];
  matterId?: number | null;
  requestId?: number | null;
  agreementId?: number | null;
  manualInputs?: Record<string, unknown>;
  /** 訂正版。退かせる元の計算書（1 枚目が本体、2 枚目以降は同じ理由で退かせる）。 */
  supersedes?: number[];
  reason?: string | null;
  /** 決定日（まとめて締めるは回の締め日）。省略すれば今日。 */
  issuedOn?: string | null;
}

export interface StatementIssuerDeps {
  royalty: Pick<RoyaltyStatementService, "preview" | "finalizeAll">;
  issues: Pick<DocumentIssueService, "createDraft" | "issue" | "void">;
}

/** 出版の条件（紙・電子）だけの束か。条件の利用形態は行の media で分かる。 */
export function isPublishingBundle(lines: BundleLine[]): boolean {
  return lines.length > 0 && lines.every((l) => l.media === "紙" || l.media === "電子");
}

export class StatementIssuer {
  constructor(private readonly database: Queryable, private readonly deps: StatementIssuerDeps) {}

  /** 条件ごとに試算する。同じ条件は 2 回選べない。 */
  async previewBundle(entries: StatementEntry[], freeDocumentIds: number[] = []): Promise<CalculationPreview[]> {
    const ids = entries.map((e) => e.conditionId);
    if (new Set(ids).size !== ids.length) {
      throw new DomainError("VALIDATION", "同じ条件を2回は選べません");
    }
    const previews: CalculationPreview[] = [];
    for (const entry of entries) {
      previews.push(await this.deps.royalty.preview({ ...entry, freeDocumentIds }));
    }
    return previews;
  }

  /** 束の受取人（共著の取り分）。取り分のある条件は受取人が 1 人に決まっていること。 */
  payeeOf(previews: Array<{ shares: unknown[] | null; payee: { partyId: number } | null }>): number | null {
    const payees = new Set(previews.filter((p) => p.shares).map((p) => p.payee?.partyId ?? 0));
    if (payees.has(0)) {
      throw new DomainError("VALIDATION", "取り分のある条件が混ざっています。受取人を選んでください");
    }
    if (payees.size > 1) {
      throw new DomainError("VALIDATION", "受取人の違う計算書は 1 枚にまとめられません");
    }
    return payees.size ? [...payees][0] : null;
  }

  /** 紙に焼き付ける行。契約番号はイン側の契約（受取人宛ての条件書を先に）。 */
  async lines(
    previews: CalculationPreview[],
    chosen: { agreementId?: number | null; manualInputs?: Record<string, unknown> } = {}
  ): Promise<BundleLine[]> {
    const termsNo = String(chosen.manualInputs?._termsNo ?? "").trim() || null;
    const out: BundleLine[] = [];
    for (const p of previews) {
      const ref = await inContractRef(this.database, p.condition.id,
        { masterAgreementId: chosen.agreementId ?? null, termsNo, payeePartyId: p.payee?.partyId ?? null });
      out.push(...withInContract(bundleLinesFor(p), ref));
    }
    return applyLineLabels(out, chosen.manualInputs ?? {});
  }

  /**
   * 使うひな形。従来の計算書（royalty_statement）を指定されていて、行が出版（紙・電子）
   * だけなら出版専用に替える。出版専用が登録されていなければ従来のまま。
   */
  async templateFor(requested: string | null | undefined, lines: BundleLine[]): Promise<string> {
    const key = String(requested ?? "").trim() || STATEMENT_KEY;
    if (key !== STATEMENT_KEY || !isPublishingBundle(lines)) return key;
    const r = await this.database.query(
      "SELECT 1 FROM document_templates WHERE template_key = $1 AND is_active", [PUB_STATEMENT_KEY]);
    return r.rows[0] ? PUB_STATEMENT_KEY : key;
  }

  async issue(input: IssueStatementInput, actor: string): Promise<{
    document: Awaited<ReturnType<DocumentIssueService["issue"]>>;
    statements: Awaited<ReturnType<RoyaltyStatementService["finalizeAll"]>>;
    totals: BundleTotals; lines: BundleLine[]; templateKey: string;
  }> {
    const supersedes = [...new Set(input.supersedes ?? [])];
    if (supersedes.length && !String(input.reason ?? "").trim()) {
      throw new DomainError("VALIDATION", "訂正版を出す理由を書いてください");
    }
    const previews = await this.previewBundle(input.entries, supersedes);
    const payeePartyId = this.payeeOf(previews);
    const totals = bundleTotals(previews);
    const lines = await this.lines(previews, { agreementId: input.agreementId ?? null, manualInputs: input.manualInputs });
    const templateKey = await this.templateFor(input.templateKey, lines);
    const eventIds = input.entries.flatMap((e) => e.eventIds ?? []);

    const draft = await this.deps.issues.createDraft({
      templateKey,
      conditionIds: input.entries.map((e) => e.conditionId),
      matterId: input.matterId ?? null, requestId: input.requestId ?? null,
      agreementId: input.agreementId ?? null,
      // 本文はここに焼き付けた行から描く。計算済みなので、印字のときに
      // 計算し直さない（rs_bundle_lines を royalty-patch が拾う）。
      manualInputs: {
        ...(input.manualInputs ?? {}),
        // 受取人（共著の取り分）。宛名・口座・源泉がこの人になる。
        ...(payeePartyId ? { _payeePartyId: payeePartyId } : {}),
        statementMode: "bundle",
        rs_bundle_lines: lines,
        rs_bundle_tax: totals.tax,
        // 出版の計算書は源泉と差引振込額まで刷る（適格請求書の仕入明細書として）。
        rs_bundle_withholding: totals.withholdingTax,
        rs_bundle_net_transfer: totals.netTransfer,
        rs_stage_notes: stageNotesOf(previews.flatMap((p) => p.events ?? [])),
        // 2枚目以降の退かせる計算書。決定の瞬間に issue-service が退かせて実績を移す。
        ...(supersedes.length > 1 ? { _supersedesExtra: supersedes.slice(1) } : {})
      },
      supersedesId: supersedes[0] ?? null,
      supersedeReason: input.reason ?? null
    }, actor);

    let document;
    try {
      document = await this.deps.issues.issue(draft.id, actor, { eventIds, issuedOn: input.issuedOn ?? null });
    } catch (error) {
      await this.deps.issues.void(draft.id, "発行できなかったため破棄", actor).catch(() => undefined);
      throw error;
    }
    // 金額は確定時にもう一度計算し直す（V1・V2 と同じ防御）。ここで弾かれたら文書を無効にする。
    let statements;
    try {
      statements = await this.deps.royalty.finalizeAll(
        input.entries.map((e) => ({
          ...e,
          documentId: document.id,
          // 訂正版なら、元から移ってきた実績（いまはこの文書を指す）をそのまま結ぶ。
          freeDocumentId: supersedes.length ? document.id : null
        })), actor);
    } catch (error) {
      await this.deps.issues.void(document.id, "計算書を結べなかったため無効", actor).catch(() => undefined);
      throw error;
    }
    return { document, statements, totals, lines, templateKey };
  }
}
