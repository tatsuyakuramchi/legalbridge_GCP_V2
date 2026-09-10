import { inTransaction, int, str, type Queryable, type Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { assertComplete, bindVariables, type BindingResult } from "./binding.js";
import { documentWarnings, type Warning } from "./preflight.js";
import { DocumentContextRepository } from "./context-repository.js";
import { DocumentRepository } from "./repository.js";
import { renderDocumentHtml } from "./render.js";
import { buildTemplateContext, seedLines } from "./template-context.js";
import { resolveAllLegacyVariables } from "./legacy-variables.js";
import { buildCandidates, type Candidate } from "./candidates.js";
import { currentYearInTokyo, formatDocumentNumber, nextSequence, normalizePrefix } from "./numbering.js";

export interface DraftInput {
  templateKey: string;
  conditionIds: number[];
  matterId?: number | null;
  agreementId?: number | null;
  manualInputs?: Record<string, unknown>;
  /** 実績。検収書はここの日付と金額を使う。 */
  eventIds?: number[];
  /** 計算結果。計算書は発行の時点でこれが要る。 */
  royalty?: Record<string, unknown> | null;
}

/** プレビューでの文書番号。発行のときに本物へ置き換わる。 */
export const PREVIEW_NUMBER = "（決定時に採番）";

export interface PreviewResult {
  html: string;
  binding: BindingResult;
  templateLabel: string;
  templateVersionId: number;
  /** 入力欄に出す候補。ひな形が供給元を宣言していなくても人が選べる。 */
  candidates: Candidate[];
  /**
   * 本文が差しているのに空で出る項目。止めはしない（欠けたまま出すのが
   * 正しいこともある）が、発行の前に人が見て決められるようにする。
   */
  warnings: Warning[];
  /**
   * 明細の欄。ひな形が行を持つとき（発注書・検収書）、条件・予定・実績から
   * 組んだ行を種として返す。画面はこれを初期値にして行ごとに直せる。
   * 直した行は manualInputs の同じ名前（items など）で返ってくる。
   */
  lines: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
}

export interface IssuedDocument {
  id: number;
  documentNo: string;
  templateVersionId: number;
  issuedAt: string;
  conditionIds: number[];
}

/**
 * 文書の作成と発行。
 *
 * V2 との違いは値の出どころだけで、採番形式・テンプレート本文・Handlebars ヘルパは
 * そのまま踏襲する（互換境界）。文書は条件を参照する側なので、
 * 発行しても条件は動かさない。
 */
export class DocumentIssueService {
  private readonly repository: DocumentRepository;
  private readonly contexts: DocumentContextRepository;

  constructor(private readonly database: Transactable) {
    this.repository = new DocumentRepository(database);
    this.contexts = new DocumentContextRepository(database);
  }

  /** 発行せずに中身を確認する。必須の未入力もここで分かる。 */
  async preview(input: DraftInput): Promise<PreviewResult> {
    try {
      const template = await this.repository.templateSource(this.database, { templateKey: input.templateKey });
      // 番号は発行のときにしか決まらない。プレビューで空にすると必須の未入力に
      // 数えられ、発行ボタンが永久に押せなくなる。何が入るかを書いておく。
      const context = await this.buildContext(this.database, input, PREVIEW_NUMBER);
      const manual = input.manualInputs ?? {};
      // 明細・合計・消費税。本文はこれを差すだけなので、作らないと空欄で出る。
      // 先に一度束縛して、項目に入った値も計算ブロックに渡す（条件書は本文の
      // 見出しが項目の値そのものなので、手入力だけでは空欄になる）。
      const first = bindVariables(template.variables, context, manual,
        { templateKey: template.templateKey });
      const computed = buildTemplateContext(template.templateKey, context, manual, first.values);
      const binding = bindVariables(template.variables, context, manual,
        { templateKey: template.templateKey, computed });
      // 候補は文脈そのものから作る。ひな形の宣言には依らない。
      const partials = await this.repository.partials();
      const values = { ...resolveAllLegacyVariables(context), ...computed, ...binding.values };
      return {
        html: renderDocumentHtml(template.htmlSource, values, partials),
        binding,
        templateLabel: template.label,
        templateVersionId: template.templateVersionId,
        candidates: buildCandidates(context),
        // 宣言済みの項目は binding.missing が別に報告する。重ねない。
        warnings: documentWarnings(template.htmlSource, values,
          template.variables.map((v) => v.name)),
        lines: Object.entries(seedLines(template.templateKey, context))
          .map(([name, rows]) => ({ name, rows }))
      };
    } catch (error) { throw translate(error); }
  }

  /** 下書きの作成。番号は振らない。 */
  async createDraft(input: DraftInput, actor: string): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const template = await this.repository.templateSource(client, { templateKey: input.templateKey });
        await this.assertConditionsIssuable(client, input.conditionIds);
        // 案件が渡されなければ、条件の載っている案件を引く。条件の画面から作った
        // 文書が案件に出てこない、という穴を塞ぐ。複数の案件に載っていれば決めない。
        const matterId = input.matterId ?? await this.matterOfConditions(client, input.conditionIds);
        const inserted = await client.query(
          `INSERT INTO documents (template_version_id, matter_id, agreement_id, status, manual_inputs)
           VALUES ($1, $2, $3, 'draft', $4::jsonb) RETURNING id`,
          [template.templateVersionId, matterId, input.agreementId ?? null,
           JSON.stringify(input.manualInputs ?? {})]
        );
        const id = Number((inserted.rows[0] as { id: number }).id);
        await this.linkConditions(client, id, input.conditionIds);
        await recordAudit(client, {
          actor, action: "document.draft", targetType: "document", targetId: id,
          detail: { templateKey: input.templateKey, conditions: input.conditionIds }
        });
        return { id };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 下書きの手入力と条件を差し替える。
   *
   * 発行は下書きに保存された manual_inputs しか見ない。直す口が無いと、
   * 作り直した下書きは中身を直せないまま発行するしかなくなる。
   */
  async updateDraft(
    documentId: number,
    input: { manualInputs?: Record<string, unknown>; conditionIds?: number[] },
    actor: string
  ): Promise<{ id: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, status FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status !== "draft") {
          throw new DomainError("CONFLICT", `下書きだけ直せます（この文書は ${row.status}）`);
        }

        if (input.manualInputs) {
          await client.query(
            "UPDATE documents SET manual_inputs = $2::jsonb WHERE id = $1",
            [documentId, JSON.stringify(input.manualInputs)]);
        }

        if (input.conditionIds) {
          const unique = [...new Set(input.conditionIds.map((n) => Number(n)))];
          if (unique.length) {
            const found = await client.query(
              "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [unique]);
            if (found.rows.length !== unique.length) {
              const known = new Set((found.rows as Array<{ id: number }>).map((r) => Number(r.id)));
              throw new DomainError("NOT_FOUND",
                `条件が見つかりません：${unique.filter((id) => !known.has(id)).join(", ")}`);
            }
          }
          await this.assertConditionsIssuable(client, unique);
          // 並べ直しも消しも同じ経路にする。差分を取るより、張り直すほうが読める。
          await client.query("DELETE FROM document_conditions WHERE document_id = $1", [documentId]);
          await this.linkConditions(client, documentId, unique);
        }

        await recordAudit(client, {
          actor, action: "document.draft.update", targetType: "document", targetId: documentId,
          detail: {
            ...(input.manualInputs ? { fields: Object.keys(input.manualInputs) } : {}),
            ...(input.conditionIds ? { conditions: input.conditionIds } : {})
          }
        });
        return { id: documentId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 発行。採番して確定値を焼き付ける。
   * 焼き付けた値（rendered_values）は記録であって参照元ではない。
   */
  /**
   * 発行。本文はここで確定して rendered_values に凍結する。
   *
   * extra は下書きに保存していない文脈（実績・計算結果）。発行のときにしか
   * 使わないので列を増やさず、作った経路から渡す。計算書は「先に計算 →
   * その値で発行」でないと、本文に金額が載らない。
   */
  async issue(
    documentId: number, actor: string,
    extra: { eventIds?: number[]; royalty?: Record<string, unknown> | null } = {}
  ): Promise<IssuedDocument> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT id, status, template_version_id, matter_id, agreement_id, manual_inputs,
                  supersedes_id, supersede_reason
             FROM documents WHERE id = $1 FOR UPDATE`, [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status !== "draft") {
          throw new DomainError("CONFLICT", `この文書はすでに ${row.status} です`);
        }
        if (!row.template_version_id) {
          throw new DomainError("VALIDATION", "テンプレートが設定されていない文書は発行できません");
        }

        const template = await this.repository.templateSource(client, {
          versionId: Number(row.template_version_id)
        });
        const linked = await client.query(
          "SELECT condition_id FROM document_conditions WHERE document_id = $1 ORDER BY line_no",
          [documentId]);
        const conditionIds = linked.rows.map((c) => Number((c as { condition_id: number }).condition_id));
        await this.assertConditionsIssuable(client, conditionIds);

        // 部分テンプレートは他のひな形に差し込む断片で、それ自体は書類ではない
        // （発注書の末尾に付く約款など）。採番の話になる前に断る。
        if (template.category === "partial") {
          throw new DomainError("VALIDATION",
            `${template.templateKey} は他のひな形に差し込む部品で、単独では発行できません`);
        }
        const prefix = normalizePrefix(template.numberPrefix);
        if (!prefix) {
          throw new DomainError("VALIDATION",
            `テンプレート ${template.templateKey} に採番プレフィックスが設定されていません`);
        }
        const year = currentYearInTokyo();
        const documentNo = formatDocumentNumber(prefix, year, await nextSequence(client, prefix, year));

        const context = await this.buildContext(client, {
          templateKey: template.templateKey,
          conditionIds,
          matterId: row.matter_id,
          agreementId: row.agreement_id,
          eventIds: extra.eventIds ?? [],
          royalty: extra.royalty ?? null
        }, documentNo);
        const manual = (row.manual_inputs as Record<string, unknown>) ?? {};
        // プレビューと同じ順で組む。先に一度束縛して、項目に入った値も
        // 計算ブロックへ渡す（条件書の見出しは項目の値そのもの）。
        const first = bindVariables(template.variables, context, manual,
          { templateKey: template.templateKey });
        const computed = buildTemplateContext(template.templateKey, context, manual, first.values);
        const binding = bindVariables(template.variables, context, manual,
          { templateKey: template.templateKey, computed });
        assertComplete(binding);

        // 焼き付けるのは計算ブロックも含めた一式。本文は明細表も合計も
        // ここから差す。宣言のある変数だけを保存すると、あとで組み直した
        // ときに表と合計が消える。
        // 本文は宣言の無い名前も差す（DOC_NO・STAFF_NAME・moneyUnit …）。
        // 対応表が解決できるものを土台に置き、計算結果と束縛した値を上に乗せる。
        const frozen = { ...resolveAllLegacyVariables(context), ...computed, ...binding.values };

        const updated = await client.query(
          `UPDATE documents
              SET document_no = $2, status = 'issued', rendered_values = $3::jsonb,
                  issued_at = now(), issued_by = $4
            WHERE id = $1 AND status = 'draft'
            RETURNING issued_at`,
          [documentId, documentNo, JSON.stringify(frozen), actor]
        );
        if (!updated.rows[0]) throw new DomainError("CONFLICT", "発行中に他の操作と競合しました");

        // 訂正版なら、ここで元と入れ替える。作るときではなく発行の瞬間に退かせる
        // ので、下書きを捨てても元は有効なまま残る。人が2手に分けてやることでは
        // ないし、2手に分けると途中で有効な版がゼロになる時間ができる。
        const supersedes = int(row.supersedes_id);
        if (supersedes) {
          await this.supersede(client, supersedes, documentId, documentNo,
            str(row.supersede_reason), actor);
        }

        await recordAudit(client, {
          actor, action: "document.issue", targetType: "document", targetId: documentId,
          detail: { documentNo, templateKey: template.templateKey, conditions: conditionIds,
                    ...(supersedes ? { supersedes } : {}) }
        });

        return {
          id: documentId,
          documentNo,
          templateVersionId: template.templateVersionId,
          issuedAt: new Date(String((updated.rows[0] as { issued_at: string }).issued_at)).toISOString(),
          conditionIds
        };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 発行済み文書の無効化。
   *
   * 行は消さない。発行した事実そのものが記録なので、消すと「何を出したか」を
   * 追えなくなる。status を void にして理由を監査に残す。
   * 保管先（Drive）のファイルにも触らない。外に出したものは取り消せない。
   */
  async void(documentId: number, reason: string, actor: string): Promise<{ id: number; documentNo: string | null }> {
    const note = String(reason ?? "").trim();
    if (!note) {
      throw new DomainError("VALIDATION", "無効にする理由を書いてください。理由なしでは無効にできません");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          "SELECT id, document_no, status FROM documents WHERE id = $1 FOR UPDATE", [documentId]);
        const row = head.rows[0] as { id: number; document_no: string | null; status: string } | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status === "void") throw new DomainError("CONFLICT", "この文書はすでに無効です");
        if (row.status === "superseded") {
          throw new DomainError("CONFLICT",
            "差し替え済みの文書は無効にできません。差し替えた新しい版を無効にしてください");
        }

        await client.query(
          "UPDATE documents SET status = 'void' WHERE id = $1", [documentId]);
        await recordAudit(client, {
          actor, action: "document.void", targetType: "document", targetId: documentId,
          detail: { documentNo: row.document_no, from: row.status, reason: note }
        });
        return { id: documentId, documentNo: row.document_no };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 訂正版を作る。発行済みの文書を下書きとして作り直す。
   *
   * 元の文書は消さない。新しい文書から supersedes_id で繋ぎ、理由を持たせる。
   * 条件・実績・手入力を引き継ぐので、そのまま直して発行し直せる。値は発行時に
   * 条件から引き直すため、条件を直してから作り直せば新しい値で出る。
   * 条件の紐づけは差し替えられるようにしてある（間違った条件を指していたとき）。
   *
   * **元が退くのは訂正版を発行した瞬間**（issue の中）。ここではまだ退かせない。
   * 先に退かせると、下書きを捨てたときに有効な版がゼロになる。
   *
   * 発行済みの文書そのものは書き換えない（出したものの記録なので）。
   * 直す唯一の道がこれになる。
   */
  async reissue(
    documentId: number, reason: string, actor: string,
    conditionIds?: number[]
  ): Promise<{ id: number; supersedesId: number }> {
    const note = String(reason ?? "").trim();
    if (!note) {
      throw new DomainError("VALIDATION", "作り直す理由を書いてください");
    }
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT id, document_no, status, template_version_id, matter_id, agreement_id, manual_inputs
             FROM documents WHERE id = $1 FOR UPDATE`, [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status !== "issued") {
          throw new DomainError("CONFLICT",
            `発行済みの文書だけ作り直せます（この文書は ${row.status}）`);
        }
        if (!row.template_version_id) {
          throw new DomainError("VALIDATION",
            "テンプレートを持たない取込文書は作り直せません。新しく登録してください");
        }
        // 訂正版の下書きが1つでも開いていたら、もう1枚作らせない。
        // 溜めても発行できるのは1枚だけ（発行した時点でこの版は退く）なので、
        // 残りは行き場のない下書きになる。
        const open = await client.query(
          `SELECT id FROM documents
            WHERE supersedes_id = $1 AND status = 'draft' LIMIT 1`, [documentId]);
        if (open.rows.length) {
          throw new DomainError("CONFLICT",
            `この文書にはもう訂正版の下書きがあります（#${(open.rows[0] as { id: number }).id}）。` +
            "それを直して発行してください");
        }

        const created = await client.query(
          `INSERT INTO documents (template_version_id, matter_id, agreement_id, status,
                                  manual_inputs, supersedes_id, supersede_reason)
           VALUES ($1, $2, $3, 'draft', $4::jsonb, $5, $6) RETURNING id`,
          [row.template_version_id, row.matter_id, row.agreement_id,
           JSON.stringify(row.manual_inputs ?? {}), documentId, note]);
        const newId = Number((created.rows[0] as { id: number }).id);

        if (conditionIds && conditionIds.length) {
          // 条件を指定し直した。実在と重複だけ確かめて、その並びで繋ぐ。
          const unique = [...new Set(conditionIds.map((n) => Number(n)))];
          const found = await client.query(
            "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [unique]);
          if (found.rows.length !== unique.length) {
            const known = new Set((found.rows as Array<{ id: number }>).map((r) => Number(r.id)));
            throw new DomainError("NOT_FOUND",
              `条件が見つかりません：${unique.filter((id) => !known.has(id)).join(", ")}`);
          }
          await this.linkConditions(client, newId, unique);
        } else {
          // 既定は引き継ぎ。参照方向は文書→条件なので、行を複製する。
          await client.query(
            `INSERT INTO document_conditions (document_id, condition_id, line_no)
             SELECT $2, condition_id, line_no FROM document_conditions WHERE document_id = $1
             ON CONFLICT (document_id, condition_id) DO NOTHING`, [documentId, newId]);
        }

        // 元はまだ退かせない。訂正版を発行した瞬間に入れ替える（issue の中）。
        // ここで退かせると、下書きを捨てたときに有効な版がゼロになる。
        await recordAudit(client, {
          actor, action: "document.reissue", targetType: "document", targetId: documentId,
          detail: { documentNo: row.document_no, newDocumentId: newId, reason: note,
                    ...(conditionIds?.length ? { conditionIds } : {}) }
        });
        return { id: newId, supersedesId: documentId };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 下敷きにして次の文書を作る。
   *
   * 訂正版（reissue）と違い、前の文書は退かない。発注書を決めたあとに同じ
   * 条件・同じ手入力で検収書を起こす、契約書から覚書を起こす、といった
   * 「次の書類」の入口。ひな形を変えられるのがここの要点で、変えないなら
   * 同じひな形の別の1枚になる（複数回発注するときなど）。
   *
   * 引き継ぐのは 条件明細・案件・合意・手入力。実績は引き継がない（次の書類が
   * どの実績についてかは、作るときに選ぶ）。手入力はひな形が違えば使われない
   * 項目も混ざるが、同じ名前の項目（担当者・部署など）はそのまま埋まる。
   */
  async derive(
    documentId: number,
    input: { templateKey?: string | null; conditionIds?: number[] },
    actor: string
  ): Promise<{ id: number; baseId: number; templateKey: string }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const head = await client.query(
          `SELECT d.id, d.document_no, d.status, d.template_version_id, d.matter_id,
                  d.agreement_id, d.manual_inputs, t.template_key
             FROM documents d
             LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
             LEFT JOIN document_templates t ON t.id = tv.template_id
            WHERE d.id = $1`, [documentId]);
        const row = head.rows[0] as Record<string, any> | undefined;
        if (!row) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
        if (row.status === "void") {
          throw new DomainError("CONFLICT", "無効にした文書は下敷きにできません");
        }
        const templateKey = String(input.templateKey ?? row.template_key ?? "").trim();
        if (!templateKey) {
          throw new DomainError("VALIDATION",
            "ひな形を持たない取込文書を下敷きにするときは、ひな形を選んでください");
        }
        // 下敷きと同じひな形でも、版は現行のものを使う（古い版で新しい書類を作らない）。
        const template = await this.repository.templateSource(client, { templateKey });
        if (template.category === "partial") {
          throw new DomainError("VALIDATION",
            `${templateKey} は他のひな形に差し込む部品で、単独では作れません`);
        }

        const created = await client.query(
          `INSERT INTO documents (template_version_id, matter_id, agreement_id, status, manual_inputs)
           VALUES ($1, $2, $3, 'draft', $4::jsonb) RETURNING id`,
          [template.templateVersionId, row.matter_id, row.agreement_id,
           JSON.stringify(row.manual_inputs ?? {})]);
        const newId = Number((created.rows[0] as { id: number }).id);

        if (input.conditionIds && input.conditionIds.length) {
          const unique = [...new Set(input.conditionIds.map((n) => Number(n)))];
          const found = await client.query(
            "SELECT id FROM conditions WHERE id = ANY($1::bigint[])", [unique]);
          if (found.rows.length !== unique.length) {
            const known = new Set((found.rows as Array<{ id: number }>).map((r) => Number(r.id)));
            throw new DomainError("NOT_FOUND",
              `条件が見つかりません：${unique.filter((id) => !known.has(id)).join(", ")}`);
          }
          await this.assertConditionsIssuable(client, unique);
          await this.linkConditions(client, newId, unique);
        } else {
          await client.query(
            `INSERT INTO document_conditions (document_id, condition_id, line_no)
             SELECT $2, condition_id, line_no FROM document_conditions WHERE document_id = $1
             ON CONFLICT (document_id, condition_id) DO NOTHING`, [documentId, newId]);
        }

        await recordAudit(client, {
          actor, action: "document.derive", targetType: "document", targetId: newId,
          detail: { baseDocumentId: documentId, baseDocumentNo: row.document_no,
                    templateKey, fromTemplateKey: row.template_key ?? null }
        });
        return { id: newId, baseId: documentId, templateKey };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 前の版を退かせる。訂正版の発行と同じトランザクションで走る。
   *
   * 実績（condition_events.document_id）も一緒に移す。移さないと、実績が
   * 前の版に取られたままになり、「すでに別の文書に結びついています。作り直す
   * なら先にその文書を無効にしてください」で止まる。それが差し替えを2手に
   * していた原因なので、ここで引き取る。
   */
  private async supersede(
    client: Queryable, oldId: number, newId: number,
    newDocumentNo: string, reason: string | null, actor: string
  ) {
    const old = await client.query(
      "SELECT id, document_no, status FROM documents WHERE id = $1 FOR UPDATE", [oldId]);
    const row = old.rows[0] as { document_no: string | null; status: string } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `差し替える元の文書 ${oldId} が見つかりません`);
    // 元がすでに無効・差し替え済みなら、退かせるものが無い。訂正版は普通に出す。
    if (row.status !== "issued") return;

    const moved = await client.query(
      `UPDATE condition_events SET document_id = $2 WHERE document_id = $1 RETURNING id`,
      [oldId, newId]);
    await client.query("UPDATE documents SET status = 'superseded' WHERE id = $1", [oldId]);

    await recordAudit(client, {
      actor, action: "document.supersede", targetType: "document", targetId: oldId,
      detail: {
        documentNo: row.document_no, replacedBy: newId, replacedByNo: newDocumentNo,
        reason, movedEvents: moved.rows.length
      }
    });
  }

  /** 発行済み文書を、そのときの版と焼き付けた値で描き直す。 */
  async renderIssued(documentId: number): Promise<{ html: string; documentNo: string | null }> {
    const document = await this.repository.find(documentId);
    if (!document) throw new DomainError("NOT_FOUND", `文書 ${documentId} が見つかりません`);
    if (!document.templateVersionId) {
      throw new DomainError("VALIDATION", "テンプレートを持たない文書は描画できません");
    }
    const template = await this.repository.templateSource(this.database, {
      versionId: document.templateVersionId
    });
    const partials = await this.repository.partials();
    return {
      html: renderDocumentHtml(template.htmlSource, document.renderedValues, partials),
      documentNo: document.documentNo
    };
  }

  private async buildContext(
    client: Queryable, input: Omit<DraftInput, "manualInputs">, documentNumber: string | null
  ) {
    const context = await this.contexts.build({
      conditionIds: input.conditionIds,
      agreementId: input.agreementId ?? null,
      matterId: input.matterId ?? null,
      eventIds: input.eventIds ?? [],
      royalty: input.royalty ?? null,
      documentNumber
    }, client);
    await this.contexts.attachScopes(client, context.conditions);
    return context as unknown as Record<string, unknown>;
  }

  /** 条件が載っている案件。1つに決まるときだけ返す。 */
  private async matterOfConditions(client: Queryable, conditionIds: number[]): Promise<number | null> {
    if (!conditionIds.length) return null;
    const r = await client.query(
      `SELECT DISTINCT matter_id FROM matter_links
        WHERE target_type = 'condition' AND target_ref = ANY($1::text[])`,
      [conditionIds.map(String)]);
    return r.rows.length === 1 ? Number((r.rows[0] as { matter_id: number }).matter_id) : null;
  }

  private async linkConditions(client: Queryable, documentId: number, conditionIds: number[]) {
    for (const [index, conditionId] of conditionIds.entries()) {
      await client.query(
        `INSERT INTO document_conditions (document_id, condition_id, line_no)
         VALUES ($1, $2, $3) ON CONFLICT (document_id, condition_id) DO NOTHING`,
        [documentId, conditionId, index + 1]
      );
    }
  }

  /** 無効・旧版の条件からは文書を出さない。 */
  private async assertConditionsIssuable(client: Queryable, conditionIds: number[]) {
    if (!conditionIds.length) return;
    const r = await client.query(
      `SELECT id, condition_no, status FROM conditions
        WHERE id = ANY($1::bigint[]) AND status IN ('void', 'superseded')`,
      [conditionIds]
    );
    if (r.rows.length) {
      const names = r.rows.map((c: Record<string, any>) => c.condition_no ?? `#${c.id}`).join("、");
      throw new DomainError("CONFLICT", `無効または旧版の条件は文書にできません: ${names}`);
    }
  }
}
