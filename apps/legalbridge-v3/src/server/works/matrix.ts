/**
 * 作品の条件をまとめて直す（作品の画面の「まとめて直す」。表で料率・取り分・共著者・クレジット・取引モデル名を直す）。
 *
 *   探す    … 作品名・作品コード・著者名（条件の相手先と、取り分の相手）で作品を探す
 *   読む    … 置いた作品の著作権表示・共著者表記（共同著作・第三者の権利）と、ライセンスの条件明細
 *              （改訂の系列は今の版と予約の版だけ）・取り分を返す
 *   当てる  … 直したセルをまとめて当てる。1 本のトランザクションで、どれか 1 つでも断られたら何も変えない。
 *              試算（dryRun）は同じ処理を流して必ず取り消し、項目ごとの結果（新しい版の番号・断られた理由）を返す。
 *
 * 直し方（利用者と決めたこと）
 *   料率・取り分   … 「改訂」（適用日から新しい版。旧版と決定済みの文書はそのまま）か「訂正」（その場で直す。
 *                    支払が立っている条件は断る）。改訂の決まりは ConditionWriteService.updateEconomics と同じ
 *                    （実績が無く適用日が今日以前ならその場で直す）。取り分だけを直すときも、改訂なら版を立てる。
 *   取引モデル名   … 版を立てずにその場で直す（支払があっても直せる。新しいモデルは条件明細そのものが版になる）
 *   クレジット     … 作品のクレジット表記の履歴に、適用開始日つきの行を足す（同じ日なら書き換え）
 *   変更理由       … 最後に 1 つ。項目ごとの操作記録と、まとめの操作記録に残す
 */

import type { Queryable, Transactable } from "../core/db.js";
import { dateStr, inTransaction, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { PinnedDatabase } from "../core/pinned-db.js";
import { ConditionWriteService } from "../conditions/write-service.js";
import { conditionNameFor, NAME_SEPARATOR, USAGE_NAME_LABEL } from "../conditions/naming.js";
import { readSublicenseKind, type ConditionUsageType } from "../core/condition-usage.js";
import { upsertCredit } from "./credits.js";
export { roundToMillion, sharePpmFromEffective } from "./share-math.js";

export interface MatrixShare { partyId: number; partyName: string; sharePpm: number; note: string | null }

export interface MatrixCondition {
  id: number; conditionNo: string | null; name: string; workId: number;
  direction: string; kind: string; usageType: string | null; pricingModel: string;
  ratePpm: number | null; flatAmount: number | null; priceBasis: string | null; currency: string;
  /** 卸単価（自社製造・他社販売など、単価で受け取る・払う条件）。最小通貨単位。 */
  unitAmount: number | null;
  mgAmount: number | null; agAmount: number | null;
  exclusivity: "exclusive" | "non_exclusive" | null;
  /** 自動更新（終了日は当初の満了日。表では直さない）。 */
  autoRenew: boolean;
  status: string; effectiveFrom: string | null; termStart: string | null; termEnd: string | null;
  counterpartyId: number | null; counterpartyName: string | null;
  distribution: string | null; shares: MatrixShare[];
  hasDocument: boolean; hasEvents: boolean; hasPayment: boolean;
  /** 規則どおりの名前（作品名｜取引モデル）。決められなければ null。 */
  suggestedName: string | null;
}

export interface MatrixWork {
  id: number; workCode: string | null; title: string;
  copyrightNotice: string | null; thirdPartyRights: string | null;
  /** 適用開始日が先の表記の行（予約）。 */
  pendingCredit: { effectiveFrom: string; copyrightNotice: string; thirdPartyRights: string | null } | null;
  conditions: MatrixCondition[];
}

export interface MatrixSearchHit { id: number; workCode: string | null; title: string; authors: string[]; conditionCount: number }

export interface MatrixConditionChange {
  id: number;
  name?: string;
  ratePpm?: number;
  /** 定額（fixed の条件）・卸単価（unit_rate の条件）・MG・AG。最小通貨単位。 */
  flatAmount?: number;
  unitAmount?: number;
  mgAmount?: number | null;
  agAmount?: number | null;
  termStart?: string | null;
  termEnd?: string | null;
  exclusivity?: "exclusive" | "non_exclusive" | null;
  shares?: Array<{ partyId: number; sharePpm: number; note?: string | null }>;
  /** 分配方法。direct＝当社（被許諾者）から各人に直接、representative＝許諾者（代表者）が受け取って分配。 */
  distribution?: "direct" | "representative";
}
export interface MatrixWorkChange { id: number; copyrightNotice?: string; thirdPartyRights?: string | null }

export interface MatrixApplyInput {
  conditions: MatrixConditionChange[];
  works: MatrixWorkChange[];
  /** 料率・取り分の当て方。 */
  mode: "revise" | "correct";
  /** 改訂の適用日（空なら今日）。 */
  effectiveFrom: string | null;
  /** クレジットの適用開始日（空なら今日）。 */
  creditFrom: string | null;
  reason: string;
}

export interface MatrixItemResult {
  target: "condition" | "work"; id: number; label: string; what: string[];
  ok: boolean; message: string | null;
  /** 改訂で新しい版ができたとき。 */
  revisedTo: { id: number; conditionNo: string | null; effectiveFrom: string | null; status: string } | null;
}

export interface MatrixApplyResult { applied: boolean; items: MatrixItemResult[] }

/**
 * 名前に入っていれば「同じ取引モデルの書き方の違い」とみなす語。入っていない名前（二次利用の「商品化」など、
 * 人が目的を書いた名前）は、規則の名前を勧めない。
 */
const MODEL_WORDS: Record<ConditionUsageType, RegExp> = {
  pub_print: /紙|書籍|単行本|文庫/,
  pub_digital: /電子/,
  pub_sub_print: /再許諾|翻訳/,
  pub_sub_digital: /再許諾|翻訳/,
  in_house: /自社製造|自社販売/,
  sublicense: /再許諾/,
  oem: /他社販売|OEM/i
};

const squash = (v: string) => v.replace(/[\s　]/g, "");

/**
 * 規則どおりの名前（作品名｜取引モデル。翻訳版の再許諾は「翻訳版再許諾（紙）」）。今の名前が既にそうなら null。
 * 名前に取引モデルの語が無ければ null（目的を書いた名前は勧めない）。取引モデルのあとの「（相手／目的）」は残す。
 */
export function matrixSuggestedName(
  current: string, workTitle: string, usageType: string | null, partName: string | null, sublicenseKind: string | null
): string | null {
  if (!usageType || !(usageType in USAGE_NAME_LABEL)) return null;
  const type = usageType as ConditionUsageType;
  const rule = conditionNameFor({ workTitle, usageType: type, partName, sublicenseKind });
  if (!rule) return null;
  // 作品名を外した残りで語を見る（作品名に「電子」などが入っていても取り違えない）。
  const cur = current.trim();
  const rest = squash(cur).startsWith(squash(workTitle)) ? cur.slice(cur.length - (squash(cur).length - squash(workTitle).length)) : cur;
  if (!MODEL_WORDS[type].test(rest)) return null;
  const label = rule.slice(rule.lastIndexOf(NAME_SEPARATOR) + 1);
  const at = cur.lastIndexOf(label);
  const tail = at >= 0 ? cur.slice(at + label.length).trim() : "";
  const keep = /^[（(].*[）)]$/.test(tail) ? tail.replace(/^\(/, "（").replace(/\)$/, "）") : "";
  const next = `${rule}${keep}`;
  return next === cur ? null : next;
}

/** 取り分の合計が 100% か・同じ相手が重なっていないか。画面と同じ確かめ。 */
export function shareProblem(shares: Array<{ partyId: number; sharePpm: number }>): string | null {
  if (!shares.length) return null;
  if (shares.some((s) => !(s.sharePpm > 0))) return "取り分は 0 より大きくしてください";
  if (new Set(shares.map((s) => s.partyId)).size !== shares.length) return "同じ共著者が 2 回入っています";
  const total = shares.reduce((n, s) => n + s.sharePpm, 0);
  if (total !== 1_000_000) return `取り分の合計が 100% になっていません（${(total / 10_000).toFixed(2).replace(/\.?0+$/, "")}%）`;
  return null;
}

export class WorkMatrixService {
  constructor(private readonly database: Transactable) {}

  /** 作品を探す。作品名・作品コード、または著者名（条件の相手先・取り分の相手）。 */
  async search(q: string, limit = 60): Promise<MatrixSearchHit[]> {
    const word = q.trim();
    if (!word) return [];
    const like = `%${word.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const r = await this.database.query(
      `WITH authors AS (
         SELECT c.work_id, p.name FROM conditions c JOIN parties p ON p.id = c.counterparty_id
          WHERE c.work_id IS NOT NULL AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
         UNION
         SELECT c.work_id, p.name FROM condition_shares s JOIN conditions c ON c.id = s.condition_id
           JOIN parties p ON p.id = s.party_id
          WHERE c.work_id IS NOT NULL AND c.status IN ('active', 'scheduled')
       )
       SELECT w.id, w.work_code, w.title,
              COALESCE((SELECT array_agg(DISTINCT a.name ORDER BY a.name) FROM authors a WHERE a.work_id = w.id), '{}') AS authors,
              (SELECT count(*)::int FROM conditions c WHERE c.work_id = w.id AND c.kind = 'license'
                  AND c.status IN ('active', 'scheduled')) AS condition_count
         FROM works w
        WHERE w.status <> 'archived'
          AND (w.title ILIKE $1 OR COALESCE(w.work_code, '') ILIKE $1
               OR EXISTS (SELECT 1 FROM authors a WHERE a.work_id = w.id AND a.name ILIKE $1))
        ORDER BY w.work_code NULLS LAST, w.id
        LIMIT $2`, [like, limit]);
    return (r.rows as any[]).map((x) => ({
      id: Number(x.id), workCode: str(x.work_code), title: String(x.title),
      authors: (x.authors as string[] | null) ?? [], conditionCount: Number(x.condition_count ?? 0)
    }));
  }

  /** 置いた作品の表。並びは渡した順。 */
  async load(workIds: number[]): Promise<MatrixWork[]> {
    const ids = [...new Set(workIds.map(Number))].filter((n) => n > 0);
    if (!ids.length) return [];
    return loadMatrix(this.database, ids);
  }

  /**
   * 条件明細（id で指定）の表の行。文書の作成画面（対象著作物を表で直す）が、文書に載せた条件の料率・取り分を
   * 出して直すのに使う。今の版・予約の版のライセンスの条件だけ（それ以外の id は返さない）。
   */
  async conditions(conditionIds: number[]): Promise<MatrixCondition[]> {
    const ids = [...new Set(conditionIds.map(Number))].filter((n) => n > 0);
    if (!ids.length) return [];
    const works = (await this.database.query(
      "SELECT DISTINCT work_id FROM conditions WHERE id = ANY($1::bigint[]) AND work_id IS NOT NULL", [ids])).rows as any[];
    const all = await loadMatrix(this.database, works.map((w) => Number(w.work_id)));
    const want = new Set(ids);
    return all.flatMap((w) => w.conditions).filter((c) => want.has(c.id));
  }

  /** まとめて当てる。dryRun は同じ処理を流して取り消す（試算）。 */
  async apply(input: MatrixApplyInput, actor: string, options: { dryRun?: boolean } = {}): Promise<MatrixApplyResult> {
    const reason = String(input.reason ?? "").trim();
    if (!options.dryRun && !reason) throw new DomainError("VALIDATION", "変更理由を入れてください");
    if (!input.conditions.length && !input.works.length) throw new DomainError("VALIDATION", "直したところがありません");
    if (input.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) throw new DomainError("VALIDATION", "適用日の形が違います");
    if (input.creditFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.creditFrom)) throw new DomainError("VALIDATION", "クレジットの適用開始日の形が違います");

    const client = await this.database.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const pinned = new PinnedDatabase(client);
      const writes = new ConditionWriteService(pinned);
      const today = dateStr((await client.query("SELECT current_date AS d")).rows[0]?.d) as string;
      const items: MatrixItemResult[] = [];

      for (const w of input.works) {
        items.push(await this.applyWork(pinned, w, input.creditFrom || today, reason || "（試算）", actor));
      }
      for (const c of input.conditions) {
        items.push(await this.applyCondition(pinned, writes, c, input, reason || "（試算）", actor));
      }
      const ok = items.every((i) => i.ok);
      if (ok && !options.dryRun) {
        await recordAudit(client, {
          actor, action: "work.matrix_apply", targetType: "work", targetId: input.works[0]?.id ?? 0,
          detail: { reason, mode: input.mode, effectiveFrom: input.effectiveFrom, creditFrom: input.creditFrom,
                    conditions: input.conditions.map((c) => c.id), works: input.works.map((w) => w.id),
                    revised: items.filter((i) => i.revisedTo).map((i) => ({ from: i.id, to: i.revisedTo!.id })) }
        });
        await client.query("COMMIT");
        committed = true;
      }
      return { applied: committed, items };
    } catch (error) {
      throw translate(error);
    } finally {
      if (!committed) { try { await client.query("ROLLBACK"); } catch { /* 握る */ } }
      client.release();
    }
  }

  /** 作品 1 点：著作権表示・共著者表記を、クレジット表記の履歴に足す。 */
  private async applyWork(db: PinnedDatabase, w: MatrixWorkChange, on: string, reason: string, actor: string): Promise<MatrixItemResult> {
    const head = (await db.query(
      "SELECT id, title, work_code, copyright_notice, third_party_rights FROM works WHERE id = $1", [w.id])).rows[0] as any;
    const label = head ? `${head.title}${head.work_code ? `（${head.work_code}）` : ""}` : `作品 #${w.id}`;
    const what: string[] = [];
    if (w.copyrightNotice !== undefined) what.push("著作権表示");
    if (w.thirdPartyRights !== undefined) what.push("共著者表記");
    const result: MatrixItemResult = { target: "work", id: w.id, label, what, ok: true, message: null, revisedTo: null };
    try {
      if (!head) throw new DomainError("NOT_FOUND", `作品 ${w.id} が見つかりません`);
      // 片方だけ直したときは、もう片方は今の値のまま行に写す（行は表記の組で持つ）。
      const notice = w.copyrightNotice !== undefined ? w.copyrightNotice : str(head.copyright_notice);
      const third = w.thirdPartyRights !== undefined ? w.thirdPartyRights : str(head.third_party_rights);
      if (!String(notice ?? "").trim()) {
        throw new DomainError("VALIDATION", "著作権表示が空です。クレジット表記は著作権表示と組で持つので、著作権表示も入れてください");
      }
      await savepoint(db, async () => {
        await upsertCredit(db, w.id, {
          effectiveFrom: on, copyrightNotice: String(notice ?? ""), thirdPartyRights: str(third), note: reason
        }, actor);
        await recordAudit(db, {
          actor, action: "work.matrix_credit", targetType: "work", targetId: w.id,
          detail: { reason, effectiveFrom: on, from: { copyrightNotice: str(head.copyright_notice), thirdPartyRights: str(head.third_party_rights) },
                    to: { copyrightNotice: notice, thirdPartyRights: third } }
        });
      });
    } catch (error) { result.ok = false; result.message = (error as Error).message; }
    return result;
  }

  /** 条件明細 1 本：名前 → 料率 → 取り分の順に当てる。 */
  private async applyCondition(
    db: PinnedDatabase, writes: ConditionWriteService, c: MatrixConditionChange, input: MatrixApplyInput, reason: string, actor: string
  ): Promise<MatrixItemResult> {
    const head = (await db.query(
      `SELECT c.id, c.condition_no, c.name, c.status, c.rate_ppm, c.pricing_model, c.distribution,
              c.flat_amount, c.unit_amount, c.mg_amount, c.ag_amount, c.term_start, c.term_end, c.exclusivity, c.auto_renew
         FROM conditions c WHERE c.id = $1`, [c.id])).rows[0] as any;
    const label = head ? `${head.condition_no ?? `#${c.id}`} ${head.name}` : `条件 #${c.id}`;
    const what: string[] = [];
    if (c.name !== undefined) what.push("取引モデル名");
    if (c.ratePpm !== undefined) what.push("料率");
    if (c.unitAmount !== undefined) what.push("卸単価");
    if (c.flatAmount !== undefined) what.push("定額");
    if (c.mgAmount !== undefined || c.agAmount !== undefined) what.push("MG・AG");
    if (c.termStart !== undefined || c.termEnd !== undefined) what.push("期間");
    if (c.exclusivity !== undefined) what.push("独占性");
    if (c.shares !== undefined) what.push("取り分");
    if (c.distribution !== undefined) what.push("分配方法");
    const result: MatrixItemResult = { target: "condition", id: c.id, label, what, ok: true, message: null, revisedTo: null };
    try {
      if (!head) throw new DomainError("NOT_FOUND", `条件 ${c.id} が見つかりません`);
      if (head.status !== "active" && head.status !== "scheduled") {
        throw new DomainError("CONFLICT", "今の版ではありません（差し替え済み・無効）。表を読み直してください");
      }
      if (c.shares) {
        const bad = shareProblem(c.shares);
        if (bad) throw new DomainError("VALIDATION", bad);
      }
      if (c.ratePpm !== undefined && head.pricing_model !== "revenue_rate") {
        throw new DomainError("VALIDATION", "料率で計算する条件ではありません");
      }
      if (c.unitAmount !== undefined && head.pricing_model !== "unit_rate") {
        throw new DomainError("VALIDATION", "単価で計算する条件ではありません");
      }
      if (c.flatAmount !== undefined && head.pricing_model !== "fixed") {
        throw new DomainError("VALIDATION", "定額の条件ではありません");
      }
      for (const [k, v] of [["卸単価", c.unitAmount], ["定額", c.flatAmount], ["MG", c.mgAmount], ["AG", c.agAmount]] as const) {
        if (v !== undefined && v !== null && !(Number.isInteger(v) && v >= 0)) throw new DomainError("VALIDATION", `${k}は 0 以上の整数（最小通貨単位）で入れてください`);
      }
      // 自動更新の条件は終了日（当初の満了日）を書き換えない。書き換えると更新回数が 0 回に戻る（#482 と同じ理由）。
      if (c.termEnd !== undefined && head.auto_renew === true && c.termEnd !== dateStr(head.term_end)) {
        throw new DomainError("VALIDATION", "自動更新の条件は、終了日を表では直せません（更新回数が 0 回に戻るため）。期間を延ばすのは「契約期間を更新」で");
      }
      {
        const start = c.termStart !== undefined ? c.termStart : dateStr(head.term_start);
        const end = c.termEnd !== undefined ? c.termEnd : dateStr(head.term_end);
        if (start && end && end < start) throw new DomainError("VALIDATION", `期間の終了（${end}）が開始（${start}）より前です`);
      }
      await savepoint(db, async () => {
        // 1. 名前はその場で（版を立てない。支払があっても直せる）。改訂する前に直すので、新しい版にも写る。
        if (c.name !== undefined) {
          const name = c.name.trim();
          if (!name) throw new DomainError("VALIDATION", "取引モデル名が空です");
          await db.query("UPDATE conditions SET name = $2, updated_at = now() WHERE id = $1", [c.id, name]);
          await recordAudit(db, {
            actor, action: "condition.rename", targetType: "condition", targetId: c.id,
            detail: { from: head.name, to: name, reason, via: "matrix" }
          });
        }
        // 2. 料率・取り分。
        let target = c.id;
        // 分配方法は取り分と組（condition_shares と conditions.distribution を一緒に書く）。
        const touchesShares = c.shares !== undefined || c.distribution !== undefined;
        // 条件の値（料率・卸単価・定額・MG・AG・期間・独占性）のうち、今と違うものだけ。
        const econ: Parameters<ConditionWriteService["updateEconomics"]>[1] = {};
        if (c.ratePpm !== undefined && c.ratePpm !== int(head.rate_ppm)) econ.ratePpm = c.ratePpm;
        if (c.unitAmount !== undefined && c.unitAmount !== int(head.unit_amount)) econ.unitAmount = c.unitAmount;
        if (c.flatAmount !== undefined && c.flatAmount !== int(head.flat_amount)) econ.flatAmount = c.flatAmount;
        if (c.mgAmount !== undefined && c.mgAmount !== int(head.mg_amount)) econ.mgAmount = c.mgAmount;
        if (c.agAmount !== undefined && c.agAmount !== int(head.ag_amount)) econ.agAmount = c.agAmount;
        if (c.termStart !== undefined && c.termStart !== dateStr(head.term_start)) econ.termStart = c.termStart;
        if (c.termEnd !== undefined && c.termEnd !== dateStr(head.term_end)) econ.termEnd = c.termEnd;
        if (c.exclusivity !== undefined && c.exclusivity !== (str(head.exclusivity) ?? null)) econ.exclusivity = c.exclusivity;
        const changesEcon = Object.keys(econ).length > 0;
        if (changesEcon || touchesShares || c.ratePpm !== undefined) {
          // 取り分だけでも、改訂なら版を立てる（料率は今の値のまま渡す。updateEconomics が版の要否を決める）。
          const ratePpm = c.ratePpm !== undefined ? c.ratePpm : int(head.rate_ppm);
          const changesRate = changesEcon;
          if (input.mode === "correct") {
            if (changesEcon) await writes.updateEconomics(c.id, econ, actor, null, { inPlace: true });
            // 取り分の訂正も、料率と同じく支払が立っていれば断る（払った額の分け方の根拠が書き換わる）。
            if (touchesShares && await hasPayment(db, c.id)) {
              throw new DomainError("CONFLICT", "支払が立っているので取り分を訂正できません。「改訂」で適用日から直してください");
            }
          } else if (changesRate || touchesShares) {
            const r = await writes.updateEconomics(c.id, changesEcon ? econ : { ratePpm }, actor, input.effectiveFrom || null);
            if (r.revisedTo) target = r.revisedTo;
          }
          if (touchesShares) {
            // 取り分を直していなければ今の取り分のまま、分配方法だけを替える。
            const shares = c.shares ?? ((await db.query(
              "SELECT party_id, share_ppm, note FROM condition_shares WHERE condition_id = $1 ORDER BY sort_order, id", [c.id])).rows as any[])
              .map((s) => ({ partyId: Number(s.party_id), sharePpm: Number(s.share_ppm), note: str(s.note) }));
            if (c.distribution !== undefined && !shares.length) {
              throw new DomainError("VALIDATION", "取り分の無い条件には分配方法を付けられません（相手先に全額）。先に共著者と取り分を入れてください");
            }
            const distribution = c.distribution ?? ((str(head.distribution) as "direct" | "representative" | null) ?? null);
            await writes.replaceShares(target, shares.map((s) => ({ partyId: s.partyId, sharePpm: s.sharePpm, note: s.note ?? null })),
                                       actor, shares.length ? distribution : null);
          }
          await recordAudit(db, {
            actor, action: "condition.matrix_update", targetType: "condition", targetId: c.id,
            detail: { reason, mode: input.mode, effectiveFrom: input.effectiveFrom, ratePpm: c.ratePpm ?? null, economics: econ,
                      shares: c.shares ?? null, distribution: c.distribution ?? null, revisedTo: target !== c.id ? target : null }
          });
        }
        if (target !== c.id) {
          const v = (await db.query("SELECT id, condition_no, effective_from, status FROM conditions WHERE id = $1", [target])).rows[0] as any;
          result.revisedTo = { id: target, conditionNo: str(v?.condition_no), effectiveFrom: dateStr(v?.effective_from), status: String(v?.status ?? "") };
        }
      });
    } catch (error) { result.ok = false; result.message = (error as Error).message; }
    return result;
  }
}

async function hasPayment(db: Queryable, id: number): Promise<boolean> {
  const r = await db.query(
    `SELECT EXISTS (SELECT 1 FROM payment_allocations al JOIN payments y ON y.id = al.payment_id
                     WHERE y.status <> 'canceled'
                       AND al.condition_id IN (SELECT x.id FROM conditions x, conditions c
                                                WHERE c.id = $1 AND COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))) AS paid`, [id]);
  return (r.rows[0] as { paid?: boolean } | undefined)?.paid === true;
}

/** 1 項目ぶんを SAVEPOINT で包む。断られた項目の書きかけだけを戻し、ほかの項目の試算を続ける。 */
async function savepoint(db: PinnedDatabase, work: () => Promise<void>): Promise<void> {
  const conn = await db.connect();
  await conn.query("BEGIN");
  try { await work(); await conn.query("COMMIT"); }
  catch (error) { await conn.query("ROLLBACK"); throw error; }
}

async function loadMatrix(db: Queryable, ids: number[]): Promise<MatrixWork[]> {
  try {
    const works = (await db.query(
      `SELECT w.id, w.work_code, w.title, w.copyright_notice, w.third_party_rights,
              (SELECT row_to_json(x) FROM (
                 SELECT effective_from, copyright_notice, third_party_rights FROM work_credits
                  WHERE work_id = w.id AND effective_from > current_date ORDER BY effective_from LIMIT 1) x) AS pending
         FROM works w WHERE w.id = ANY($1::bigint[])`, [ids])).rows as any[];
    const conds = (await db.query(
      `SELECT c.id, c.condition_no, c.name, c.work_id, c.direction, c.kind, c.usage_type, c.pricing_model, c.rate_ppm,
              c.flat_amount, c.price_basis, c.currency, c.status, c.effective_from, c.term_start, c.term_end,
              c.unit_amount, c.mg_amount, c.ag_amount, c.exclusivity, c.auto_renew,
              c.counterparty_id, p.name AS counterparty_name, c.distribution, c.sublicense_kind, wp.name AS part_name,
              EXISTS (SELECT 1 FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
                       WHERE dc.condition_id = c.id AND d.status IN ('issued', 'superseded')) AS has_document,
              EXISTS (SELECT 1 FROM condition_events e WHERE e.condition_id = c.id AND e.status = 'active') AS has_events,
              EXISTS (SELECT 1 FROM payment_allocations al JOIN payments y ON y.id = al.payment_id
                       WHERE y.status <> 'canceled'
                         AND al.condition_id IN (SELECT x.id FROM conditions x WHERE COALESCE(x.series_id, x.id) = COALESCE(c.series_id, c.id))) AS has_payment
         FROM conditions c
         LEFT JOIN parties p ON p.id = c.counterparty_id
         LEFT JOIN work_parts wp ON wp.id = c.work_part_id
        WHERE c.work_id = ANY($1::bigint[]) AND c.kind = 'license' AND c.status IN ('active', 'scheduled')
        ORDER BY c.work_id, c.direction, c.usage_type NULLS LAST, c.condition_no NULLS LAST, c.id`, [ids])).rows as any[];
    const shares = conds.length ? (await db.query(
      `SELECT s.condition_id, s.party_id, p.name, s.share_ppm, s.note
         FROM condition_shares s JOIN parties p ON p.id = s.party_id
        WHERE s.condition_id = ANY($1::bigint[]) ORDER BY s.condition_id, s.sort_order, s.id`,
      [conds.map((c) => Number(c.id))])).rows as any[] : [];
    const byWork = new Map(works.map((w) => [Number(w.id), w]));
    return ids.filter((id) => byWork.has(id)).map((id) => {
      const w = byWork.get(id)!;
      const title = String(w.title ?? "");
      const pending = w.pending as Record<string, any> | null;
      return {
        id, workCode: str(w.work_code), title,
        copyrightNotice: str(w.copyright_notice), thirdPartyRights: str(w.third_party_rights),
        pendingCredit: pending ? { effectiveFrom: String(pending.effective_from), copyrightNotice: String(pending.copyright_notice ?? ""),
                                   thirdPartyRights: str(pending.third_party_rights) } : null,
        conditions: conds.filter((c) => Number(c.work_id) === id).map((c) => ({
          id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""), workId: id,
          direction: String(c.direction), kind: String(c.kind), usageType: str(c.usage_type), pricingModel: String(c.pricing_model),
          ratePpm: int(c.rate_ppm), flatAmount: int(c.flat_amount), priceBasis: str(c.price_basis), currency: String(c.currency ?? "JPY"),
          unitAmount: int(c.unit_amount), mgAmount: int(c.mg_amount), agAmount: int(c.ag_amount),
          exclusivity: str(c.exclusivity) === "exclusive" ? "exclusive" : str(c.exclusivity) === "non_exclusive" ? "non_exclusive" : null,
          autoRenew: c.auto_renew === true,
          status: String(c.status), effectiveFrom: dateStr(c.effective_from), termStart: dateStr(c.term_start), termEnd: dateStr(c.term_end),
          counterpartyId: int(c.counterparty_id), counterpartyName: str(c.counterparty_name),
          distribution: str(c.distribution),
          shares: shares.filter((s) => Number(s.condition_id) === Number(c.id)).map((s) => ({
            partyId: Number(s.party_id), partyName: String(s.name), sharePpm: Number(s.share_ppm), note: str(s.note)
          })),
          hasDocument: c.has_document === true, hasEvents: c.has_events === true, hasPayment: c.has_payment === true,
          suggestedName: matrixSuggestedName(String(c.name ?? ""), title, str(c.usage_type), str(c.part_name),
                                             readSublicenseKind(c.sublicense_kind))
        }))
      };
    });
  } catch (error) { throw translate(error); }
}
