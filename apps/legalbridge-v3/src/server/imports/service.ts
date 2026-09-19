import type { Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { PartyWriteService } from "../parties/write-service.js";
import { WorkWriteService, type WorkPatch } from "../works/write-service.js";
import { ConditionWriteService, type EconomicsPatch, type LicenseSetRow } from "../conditions/write-service.js";
import { conditionNameFor, parseUsageType } from "../conditions/naming.js";
import { parseLanguages, parseRegions } from "../core/rights-scope.js";
import type { ConditionScope } from "../core/model.js";
import { csvAmount, csvBoolean, parseCsv } from "./parse.js";

/**
 * CSV の一括取込。
 *
 * 必ず先に試算（dry-run）を通す。500行を書いてから結果を見るのでは、
 * マスタを壊したあとにしか気づけない。試算は同じ検証を通して
 * 「何件入り、何件が既存と重なり、何件が弾かれるか」を返す。
 *
 * 登録そのものは通常の登録サービスを呼ぶ。取込だけ別の規則で入ると、
 * 画面から入れた行と取り込んだ行で品質が変わる。
 */

export type ImportKind = "parties" | "works" | "license_conditions";

/**
 * 取り込み方。
 *   create … 新しく作る（既存と重なる行は飛ばす）
 *   update … 既に登録してあるものに、CSV に書いてある列だけを当てる
 *
 * 備考や著作権表示だけをまとめて入れたい、という用が create では通らなかった。
 * 同名は「取り込むと2件になります」で弾かれ、作品コードが同じなら止まるため。
 */
export type ImportMode = "create" | "update";

export interface ImportSpec {
  kind: ImportKind;
  label: string;
  /** 必須の見出し。 */
  required: string[];
  /** 任意の見出し。 */
  optional: string[];
  sample: string;
  /** 既存に当てる取り込み（update）ができるか。 */
  updatable?: boolean;
  /** update で当てられる列。ここに無い列は読み飛ばす。 */
  updateColumns?: string[];
  /** update のときの見本。 */
  updateSample?: string;
  /** update のときの当て方の説明。 */
  updateHint?: string;
}

export const IMPORT_SPECS: ImportSpec[] = [
  {
    kind: "parties", label: "取引先",
    required: ["名称", "区分"],
    optional: ["取引先コード", "カナ", "インボイス番号", "法人番号", "源泉対象", "別名",
               "代表者肩書", "代表者氏名", "主担当氏名", "主担当メール", "主担当部署"],
    sample: "名称,区分,取引先コード,カナ,インボイス番号,法人番号,源泉対象,別名,代表者肩書,代表者氏名,主担当氏名,主担当メール,主担当部署\n" +
            "株式会社甲,法人,,カブシキガイシャコウ,T1234567890123,1234567890123,,甲社,代表取締役,甲野 一郎,乙山 花子,otoyama@example.co.jp,制作部\n" +
            "山田太郎,個人,V-0102,ヤマダタロウ,,,対象,やまだ,,,,,"
  },
  {
    kind: "works", label: "作品",
    required: ["作品名"],
    optional: ["カナ", "種別", "状態", "事業区分", "作品コード", "親作品", "著作権表示", "第三者権利", "備考"],
    sample: "作品名,カナ,種別,状態,事業区分,作品コード,親作品,著作権表示,第三者権利,備考\n" +
            "原作小説,ゲンサクショウセツ,原作IP,発売済,出版,,,© 2026 著者名,,\n" +
            "新作ボードゲーム,シンサクボードゲーム,派生作品,企画中,ゲーム,,原作小説,© 2026 著者名 / Arclight,挿絵：〇〇,",
    updatable: true,
    updateHint: "当てる先は 作品コード（無ければ 作品名）。親作品はここでは付け替えません（系譜は作品画面で）",
    updateColumns: ["カナ", "種別", "状態", "事業区分", "著作権表示", "第三者権利", "備考", "作品名"],
    updateSample: "作品コード,備考\n" +
                  "WRK-2026-0001,初版1000部。奥付の表記は別紙のとおり\n" +
                  "WRK-2026-0002,重版分は別途協議"
  },
  {
    kind: "license_conditions", label: "利用許諾条件（作品に紐づく IN の許諾）",
    required: ["作品名", "許諾者", "取引モデル", "料率"],
    optional: ["作品コード", "許諾者コード", "契約番号", "独占", "MG", "AG", "再許諾先", "目的",
               "開始日", "終了日", "通貨", "支払条件", "地域", "言語", "備考"],
    sample: "作品名,作品コード,許諾者,許諾者コード,契約番号,取引モデル,料率,独占,MG,AG,再許諾先,目的,開始日,終了日,通貨,支払条件,地域,言語,備考\n" +
            "ito,,権利者名,,AGR-2026-0001,自社製造・自社販売,2,非独占,100000,,,,2026-10-01,2031-09-30,JPY,,全世界,,\n" +
            "ito,,権利者名,,AGR-2026-0001,自社製造・他社販売,2,非独占,,,,,2026-10-01,2031-09-30,JPY,,全世界,,\n" +
            "ito,,権利者名,,AGR-2026-0001,再許諾,50,非独占,,,Alpha Games,英語版の製造販売,2026-10-01,2031-09-30,JPY,,全世界,,\n" +
            "星降る夜のはなし,,著者名,,,紙出版,11,非独占,,,,,2026-10-01,,JPY,,,日本語,\n" +
            "星降る夜のはなし,,著者名,,,電子出版,15,非独占,,,,,2026-10-01,,JPY,,,日本語,",
    updatable: true,
    updateHint: "当てる先は 条件番号。無ければ 作品名（または作品コード）＋取引モデルで当てます" +
                "（再許諾は 再許諾先 も見ます）。作品・許諾者・契約・通貨は替えられません（条件の画面で）",
    updateColumns: ["料率", "独占", "MG", "AG", "開始日", "終了日", "支払条件", "地域", "言語", "備考"],
    updateSample: "条件番号,料率,開始日,終了日\n" +
                  "CL-2026-00451,11,2026-10-01,2031-09-30\n" +
                  "CL-2026-00452,15,,"
  }
];

export interface RowOutcome {
  /** 1 始まり。見出しを除いた行番号ではなく、ファイル上の行番号。 */
  line: number;
  status: "ok" | "duplicate" | "skip" | "error";
  label: string;
  message?: string;
  id?: number;
  code?: string | null;
}

export interface ImportReport {
  kind: ImportKind;
  mode: ImportMode;
  dryRun: boolean;
  total: number;
  ok: number;
  duplicate: number;
  /** 当てる項目が無く、何もしなかった行（update のとき）。 */
  skipped: number;
  error: number;
  rows: RowOutcome[];
}

const WORK_KIND: Record<string, "own" | "source_ip" | "derivative"> = {
  自社作品: "own", own: "own", 原作IP: "source_ip", source_ip: "source_ip",
  派生作品: "derivative", derivative: "derivative"
};
const WORK_STATUS: Record<string, "planning" | "in_production" | "released" | "archived"> = {
  企画中: "planning", planning: "planning", 制作中: "in_production", in_production: "in_production",
  発売済: "released", released: "released", 終了: "archived", archived: "archived"
};

/** 利用許諾条件の CSV の1行。作品×許諾者×契約×期間で束ねて許諾セットにする。 */
interface LicenseCsvRow {
  line: number;
  label: string;
  workId: number; workTitle: string;
  partyId: number; partyName: string;
  agreementId: number | null;
  termStart: string | null; termEnd: string | null;
  currency: string;
  paymentTerms: string | null;
  notes: string | null;
  scopes: ConditionScope[];
  row: LicenseSetRow;
}

const EXCLUSIVITY: Record<string, "exclusive" | "non_exclusive"> = {
  独占: "exclusive", exclusive: "exclusive", 非独占: "non_exclusive", non_exclusive: "non_exclusive"
};

function csvDate(value: string | undefined): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (!m) throw new DomainError("VALIDATION", `日付は 2026-10-01 か 2026/10/01 の形で入れてください（"${s}"）`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export class ImportService {
  private readonly parties: PartyWriteService;
  private readonly works: WorkWriteService;
  private readonly conditions: ConditionWriteService;

  constructor(private readonly database: Transactable) {
    this.parties = new PartyWriteService(database);
    this.works = new WorkWriteService(database);
    this.conditions = new ConditionWriteService(database);
  }

  async run(input: {
    kind: ImportKind; csv: string; dryRun: boolean; actor: string; mode?: ImportMode;
  }): Promise<ImportReport> {
    const spec = IMPORT_SPECS.find((s) => s.kind === input.kind);
    if (!spec) throw new DomainError("VALIDATION", `取り込めない種類です: ${input.kind}`);
    const mode: ImportMode = input.mode ?? "create";
    if (mode === "update" && !spec.updatable) {
      throw new DomainError("VALIDATION", `${spec.label}は既存に当てる取り込みができません`);
    }

    const parsed = parseCsv(input.csv);
    if (mode === "update") {
      // どれを直すかが決まればよい。値の列は書いてあるものだけ当てる。
      if (input.kind === "license_conditions") {
        const byNo = parsed.headers.includes("条件番号");
        const byWork = (parsed.headers.includes("作品名") || parsed.headers.includes("作品コード"))
          && parsed.headers.includes("取引モデル");
        if (!byNo && !byWork) {
          throw new DomainError("VALIDATION",
            "更新には「条件番号」か、「作品名（または作品コード）」と「取引モデル」の見出しが要ります");
        }
      } else if (!parsed.headers.includes("作品コード") && !parsed.headers.includes("作品名")) {
        throw new DomainError("VALIDATION",
          "更新には「作品コード」か「作品名」の見出しが要ります。どの作品を直すかが決まりません");
      }
    } else {
      const missing = spec.required.filter((h) => !parsed.headers.includes(h));
      if (missing.length) {
        throw new DomainError("VALIDATION",
          `見出しが足りません: ${missing.join(", ")}。1行目に見出しを入れてください`);
      }
    }

    const rows: RowOutcome[] = [];
    if (input.kind === "license_conditions" && mode === "create") {
      return this.licenseConditions(parsed.rows, input.dryRun, input.actor);
    }
    // 同じ CSV の前の行で作る作品は、試算でも親作品として当たったことにする
    // （原作の行 → 派生作品の行 の順に書けば1回で入る）。
    const earlier = new Set<string>();
    for (const [index, row] of parsed.rows.entries()) {
      const line = index + 2;   // 1行目は見出し
      try {
        const outcome = input.kind === "license_conditions"
          ? await this.conditionUpdate(row, input.dryRun, input.actor)
          : input.kind === "parties"
            ? await this.party(row, input.dryRun, input.actor)
            : mode === "update"
              ? await this.workUpdate(row, input.dryRun, input.actor)
              : await this.work(row, input.dryRun, input.actor, earlier);
        for (const k of [row["作品名"], row["作品コード"]]) {
          const v = String(k ?? "").trim().toLowerCase();
          if (v) earlier.add(v);
        }
        rows.push({ line, ...outcome });
      } catch (error) {
        const e = error as DomainError;
        rows.push({
          line,
          status: e?.code === "CONFLICT" ? "duplicate" : "error",
          label: String(row["条件番号"] ?? row[spec.required[0]] ?? row["作品コード"] ?? ""),
          message: e?.message ?? (mode === "update" ? "更新に失敗しました" : "登録に失敗しました")
        });
      }
    }

    return {
      kind: input.kind, mode, dryRun: input.dryRun, total: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
      skipped: rows.filter((r) => r.status === "skip").length,
      error: rows.filter((r) => r.status === "error").length,
      rows
    };
  }

  /**
   * 既に登録してある作品に、CSV に書いてある列だけを当てる。
   *
   * 当てる先は作品コード（無ければ作品名）で決める。空欄の列は触らない。
   * 「消す」ための口ではないので、空欄にして消すことはできない。
   * 親作品はここでは付け替えない（系譜は作品画面で直す）。
   */
  private async workUpdate(row: Record<string, string>, dryRun: boolean, actor: string):
    Promise<Omit<RowOutcome, "line">> {
    const text = (header: string) => String(row[header] ?? "").trim() || null;
    const code = text("作品コード");
    const title = text("作品名");
    if (!code && !title) throw new DomainError("VALIDATION", "作品コードも作品名も空です");

    const found = code
      ? await this.database.query(
          "SELECT id, work_code, title FROM works WHERE lower(btrim(work_code)) = lower(btrim($1)) LIMIT 2", [code])
      : await this.database.query(
          "SELECT id, work_code, title FROM works WHERE btrim(title) = btrim($1) LIMIT 2", [title]);
    const hits = found.rows as Array<{ id: number; work_code: string | null; title: string }>;
    const label = title ?? code ?? "";
    if (!hits.length) {
      throw new DomainError("NOT_FOUND", code
        ? `作品コード ${code} の作品が見つかりません`
        : `作品「${title}」が見つかりません。作品コードで指定するか、先に登録してください`);
    }
    if (hits.length > 1) {
      throw new DomainError("VALIDATION", `作品「${label}」が複数あります。作品コードで指定してください`);
    }
    const work = hits[0];
    const who = `${work.work_code ?? `#${work.id}`} ${work.title}`;

    const patch: WorkPatch = {};
    const changed: string[] = [];
    const put = <K extends keyof WorkPatch>(header: string, key: K, value: WorkPatch[K]) => {
      patch[key] = value; changed.push(header);
    };
    const kana = text("カナ");
    if (kana) put("カナ", "titleKana", kana);
    const kindText = text("種別");
    if (kindText) {
      if (!WORK_KIND[kindText]) {
        throw new DomainError("VALIDATION",
          `種別は「自社作品」「原作IP」「派生作品」のいずれかです（"${kindText}"）`);
      }
      put("種別", "kind", WORK_KIND[kindText]);
    }
    const statusText = text("状態");
    if (statusText) {
      if (!WORK_STATUS[statusText]) {
        throw new DomainError("VALIDATION",
          `状態は「企画中」「制作中」「発売済」「終了」のいずれかです（"${statusText}"）`);
      }
      put("状態", "status", WORK_STATUS[statusText]);
    }
    const businessLine = text("事業区分");
    if (businessLine) put("事業区分", "businessLine", businessLine);
    const copyright = text("著作権表示");
    if (copyright) put("著作権表示", "copyrightNotice", copyright);
    const thirdParty = text("第三者権利");
    if (thirdParty) put("第三者権利", "thirdPartyRights", thirdParty);
    const remarks = text("備考");
    if (remarks) put("備考", "remarks", remarks);
    // コードで当てた行に別の作品名が書いてあれば改名。名前で当てた行は改名できない
    // （当てる手がかりそのものなので）。
    if (code && title && title !== String(work.title)) put("作品名", "title", title);

    const notes: string[] = [];
    if (text("親作品")) notes.push("親作品は更新しません（作品画面で付け替えてください）");
    const tail = notes.length ? `。${notes.join("／")}` : "";

    if (!changed.length) {
      return { status: "skip", label, id: Number(work.id), code: work.work_code,
               message: `${who}：当てる項目がありません（空欄の列は触りません）${tail}` };
    }
    const what = changed.join("・");
    if (dryRun) {
      return { status: "ok", label, id: Number(work.id), code: work.work_code,
               message: `${who} の ${what} を更新します${tail}` };
    }
    await this.works.update(Number(work.id), patch, actor);
    return { status: "ok", label, id: Number(work.id), code: work.work_code,
             message: `${who} の ${what} を更新しました${tail}` };
  }

  private async party(row: Record<string, string>, dryRun: boolean, actor: string):
    Promise<Omit<RowOutcome, "line">> {
    const name = String(row["名称"] ?? "").trim();
    const kindText = String(row["区分"] ?? "").trim();
    const kind = ["個人", "individual"].includes(kindText) ? "individual"
      : ["法人", "corporate"].includes(kindText) ? "corporate" : null;
    if (!kind) {
      throw new DomainError("VALIDATION", `区分は「法人」か「個人」です（"${kindText}"）`);
    }

    // 取引先コード。空なら自動採番。書いてあれば他と重ならないことを確かめる。
    const partyCode = String(row["取引先コード"] ?? "").trim() || null;
    if (partyCode) {
      const taken = await this.database.query(
        "SELECT id, name FROM parties WHERE lower(btrim(party_code)) = lower(btrim($1)) LIMIT 1", [partyCode]);
      const hit = taken.rows[0] as { id: number; name: string } | undefined;
      if (hit) throw new DomainError("CONFLICT", `取引先コード ${partyCode} は既に「${hit.name}」で使われています`);
    }

    if (dryRun) {
      // 書かずに、同名が既にいるかだけ確かめる。
      const same = await this.database.query(
        "SELECT id, party_code FROM parties WHERE btrim(name) = btrim($1) AND status <> 'merged' LIMIT 1",
        [name]);
      const hit = same.rows[0] as { id: number; party_code: string | null } | undefined;
      if (hit) {
        return { status: "duplicate", label: name,
                 message: `同名が既にあります（${hit.party_code ?? `#${hit.id}`}）。この行は飛ばされます`,
                 id: Number(hit.id) };
      }
      return { status: "ok", label: name };
    }

    const created = await this.parties.create({
      name, kind, partyCode,
      representativeTitle: row["代表者肩書"] || null,
      representativeName: row["代表者氏名"] || null,
      primaryContact: { name: row["主担当氏名"] || null, email: row["主担当メール"] || null, department: row["主担当部署"] || null },
      nameKana: row["カナ"] || null,
      invoiceNo: row["インボイス番号"] || null,
      corporateNo: row["法人番号"] || null,
      withholding: csvBoolean(row["源泉対象"]) ?? false,
      aliases: String(row["別名"] ?? "").split(/[,、\/]/).map((a) => a.trim()).filter(Boolean)
    }, actor);
    return { status: "ok", label: name, id: created.id, code: created.partyCode };
  }

  private async work(row: Record<string, string>, dryRun: boolean, actor: string,
                     earlier: Set<string> = new Set()):
    Promise<Omit<RowOutcome, "line">> {
    const title = String(row["作品名"] ?? "").trim();
    if (!title) throw new DomainError("VALIDATION", "作品名が空です");

    const kindText = String(row["種別"] ?? "").trim();
    if (kindText && !WORK_KIND[kindText]) {
      throw new DomainError("VALIDATION",
        `種別は「自社作品」「原作IP」「派生作品」のいずれかです（"${kindText}"）`);
    }
    const statusText = String(row["状態"] ?? "").trim();
    if (statusText && !WORK_STATUS[statusText]) {
      throw new DomainError("VALIDATION",
        `状態は「企画中」「制作中」「発売済」「終了」のいずれかです（"${statusText}"）`);
    }

    // 親作品（原作）。コードか作品名で当てる。書いてあるのに当たらなければ止める
    // （黙って親なしで作ると、原作から派生作品を辿れない）。
    const parentText = String(row["親作品"] ?? "").trim();
    let parentWorkId: number | null = null;
    if (parentText) {
      const parent = await this.database.query(
        `SELECT id FROM works
          WHERE lower(btrim(work_code)) = lower(btrim($1)) OR btrim(title) = btrim($1)
          LIMIT 2`, [parentText]);
      if (parent.rows.length !== 1) {
        if (parent.rows.length === 0 && dryRun && earlier.has(parentText.toLowerCase())) {
          // この CSV の前の行で作る作品。登録のときは順に作るので当たる。
          parentWorkId = null;
        } else {
          throw new DomainError("VALIDATION", parent.rows.length
            ? `親作品「${parentText}」が複数あります。作品コードで指定してください`
            : `親作品「${parentText}」が見つかりません。先に親作品の行を取り込むか、登録してください`);
        }
      } else {
        parentWorkId = Number((parent.rows[0] as { id: number }).id);
      }
    }
    const workCode = String(row["作品コード"] ?? "").trim() || null;
    if (workCode) {
      const taken = await this.database.query(
        "SELECT id FROM works WHERE lower(btrim(work_code)) = lower(btrim($1)) LIMIT 1", [workCode]);
      if (taken.rows[0]) {
        throw new DomainError("CONFLICT", `作品コード ${workCode} は既に使われています（#${Number((taken.rows[0] as { id: number }).id)}）`);
      }
    }

    if (dryRun) {
      const same = await this.database.query(
        "SELECT id, work_code FROM works WHERE btrim(title) = btrim($1) LIMIT 1", [title]);
      const hit = same.rows[0] as { id: number; work_code: string | null } | undefined;
      return hit
        ? { status: "duplicate", label: title,
            message: `同名の作品が既にあります（${hit.work_code ?? `#${hit.id}`}）。取り込むと2件になります`,
            id: Number(hit.id) }
        : { status: "ok", label: title };
    }

    const created = await this.works.create({
      title,
      titleKana: row["カナ"] || null,
      kind: kindText ? WORK_KIND[kindText] : (parentWorkId ? "derivative" : "own"),
      status: statusText ? WORK_STATUS[statusText] : "planning",
      businessLine: row["事業区分"] || null,
      remarks: row["備考"] || null,
      workCode,
      parentWorkId,
      copyrightNotice: row["著作権表示"] || null,
      thirdPartyRights: row["第三者権利"] || null
    }, actor);
    return { status: "ok", label: title, id: created.id, code: created.workCode };
  }

  /**
   * 利用許諾条件の一括登録。1行＝条件1本（作品×許諾者×取引モデル）。
   *
   * 条件名は打たせない。作品名｜取引モデル（再許諾は 再許諾先／目的 つき）で
   * 付ける。登録は許諾セット（createLicenseSet）を通す：同じ作品・許諾者・
   * 契約・期間の行を1束にして1トランザクションで作るので、重複の検査も
   * 画面から登録したときと同じ。
   *
   * 試算では何も書かず、作品・許諾者・契約の当たりと値の検証だけ返す。
   */
  private async licenseConditions(
    raw: Array<Record<string, string>>, dryRun: boolean, actor: string
  ): Promise<ImportReport> {
    const outcomes = new Map<number, RowOutcome>();
    const parsedRows: LicenseCsvRow[] = [];
    for (const [index, row] of raw.entries()) {
      const line = index + 2;
      const label = `${String(row["作品名"] ?? "").trim()} ／ ${String(row["取引モデル"] ?? "").trim()}`;
      try {
        parsedRows.push(await this.licenseRow(line, label, row));
      } catch (error) {
        const e = error as DomainError;
        outcomes.set(line, { line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label,
                             message: e?.message ?? "読めませんでした" });
      }
    }

    // 束ねる：作品×許諾者×契約×期間×通貨。
    const groups = new Map<string, LicenseCsvRow[]>();
    for (const r of parsedRows) {
      const key = [r.workId, r.partyId, r.agreementId ?? "", r.termStart ?? "", r.termEnd ?? "", r.currency].join("|");
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const group of groups.values()) {
      const first = group[0];
      // 束の中の名前の重複（同じ取引モデル、同じ再許諾先・目的）は登録側が止める。
      const names = group.map((r) => conditionNameFor({ workTitle: r.workTitle, usageType: r.row.usageType,
                                                          sublicensee: r.row.sublicensee, purpose: r.row.purpose }) ?? "");
      if (dryRun) {
        // 既存との重複は登録側と同じ規則で見る（書かずに）。
        const existing = await this.database.query(
          `SELECT c.condition_no, c.usage_type, c.name
             FROM conditions c
            WHERE c.work_id = $1 AND c.counterparty_id = $2 AND c.direction = 'in'
              AND c.status IN ('active', 'scheduled')`, [first.workId, first.partyId]);
        for (const [i, r] of group.entries()) {
          const clash = (existing.rows as Array<{ condition_no: string | null; usage_type: string | null; name: string | null }>)
            .find((x) => x.usage_type === r.row.usageType
              && (r.row.usageType !== "sublicense" || String(x.name ?? "").trim() === names[i]));
          outcomes.set(r.line, clash
            ? { line: r.line, status: "duplicate", label: r.label,
                message: `${r.partyName} の同じ取引モデルの条件（${clash.condition_no ?? "番号なし"}）が既にあります。この束は飛ばされます` }
            : { line: r.line, status: "ok", label: r.label, message: `条件名：${names[i]}` });
        }
        continue;
      }
      try {
        const made = await this.conditions.createLicenseSet({
          title: null, counterpartyId: first.partyId, workId: first.workId, agreementId: first.agreementId,
          termStart: first.termStart, termEnd: first.termEnd, currency: first.currency,
          paymentTerms: first.paymentTerms, notes: first.notes, scopes: first.scopes,
          rows: group.map((r) => r.row)
        }, actor);
        for (const [i, r] of group.entries()) {
          const c = made.conditions[i];
          outcomes.set(r.line, { line: r.line, status: "ok", label: r.label, id: c?.id, code: c?.conditionNo ?? null,
                                 message: `条件名：${names[i]}` });
        }
      } catch (error) {
        const e = error as DomainError;
        for (const r of group) {
          outcomes.set(r.line, { line: r.line, status: e?.code === "CONFLICT" ? "duplicate" : "error", label: r.label,
                                 message: e?.message ?? "登録に失敗しました" });
        }
      }
    }

    const rows = [...outcomes.values()].sort((a, b) => a.line - b.line);
    return {
      kind: "license_conditions", mode: "create", dryRun, total: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
      skipped: 0,
      error: rows.filter((r) => r.status === "error").length,
      rows
    };
  }

  /** 1行を読む。作品・許諾者・契約は1件に決まるときだけ通す。 */
  private async licenseRow(line: number, label: string, row: Record<string, string>): Promise<LicenseCsvRow> {
    const usageType = parseUsageType(row["取引モデル"]);
    if (!usageType) {
      throw new DomainError("VALIDATION",
        `取引モデルは「自社製造・自社販売」「再許諾」「自社製造・他社販売」「紙出版」「電子出版」のいずれかです（"${String(row["取引モデル"] ?? "").trim()}"）`);
    }
    const rateText = String(row["料率"] ?? "").trim().replace(/[%％]/g, "");
    const ratePct = Number(rateText);
    if (!rateText || !Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
      throw new DomainError("VALIDATION", `料率は 0〜100（%）で入れてください（"${String(row["料率"] ?? "").trim()}"）`);
    }
    const exclText = String(row["独占"] ?? "").trim();
    if (exclText && !EXCLUSIVITY[exclText]) {
      throw new DomainError("VALIDATION", `独占は「独占」か「非独占」です（"${exclText}"）`);
    }
    const sublicensee = String(row["再許諾先"] ?? "").trim() || null;
    const purpose = String(row["目的"] ?? "").trim() || null;
    if (usageType === "sublicense" && !sublicensee) {
      throw new DomainError("VALIDATION", "再許諾は「再許諾先」を入れてください（条件名「作品名｜再許諾（再許諾先／目的）」になります）");
    }

    const work = await this.findOne(
      `SELECT id, title FROM works
        WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
           OR ($2 <> '' AND (btrim(title) = btrim($2) OR btrim(COALESCE(title_kana, '')) = btrim($2)))
        LIMIT 3`,
      [String(row["作品コード"] ?? "").trim(), String(row["作品名"] ?? "").trim()],
      `作品「${String(row["作品コード"] ?? row["作品名"] ?? "").trim()}」`);
    const party = await this.findOne(
      `SELECT id, name FROM parties
        WHERE status <> 'merged'
          AND (($1 <> '' AND lower(btrim(party_code)) = lower(btrim($1)))
            OR ($2 <> '' AND (btrim(name) = btrim($2) OR btrim(COALESCE(name_kana, '')) = btrim($2)
                              OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE btrim(a) = btrim($2)))))
        LIMIT 3`,
      [String(row["許諾者コード"] ?? "").trim(), String(row["許諾者"] ?? "").trim()],
      `許諾者「${String(row["許諾者コード"] ?? row["許諾者"] ?? "").trim()}」`);
    let agreementId: number | null = null;
    const agreementNo = String(row["契約番号"] ?? "").trim();
    if (agreementNo) {
      const a = await this.findOne(
        `SELECT id, counterparty_id AS cp FROM agreements WHERE lower(btrim(agreement_no)) = lower(btrim($1)) LIMIT 3`,
        [agreementNo], `契約番号 ${agreementNo}`);
      if (Number(a.cp) !== Number(party.id)) {
        throw new DomainError("VALIDATION", `契約 ${agreementNo} は ${String(party.name)} の契約ではありません`);
      }
      agreementId = Number(a.id);
    }
    const scopes: ConditionScope[] = [
      ...parseRegions(String(row["地域"] ?? "")).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })),
      ...parseLanguages(String(row["言語"] ?? "")).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null }))
    ];
    return {
      line, label: `${String(work.title)} ／ ${String(row["取引モデル"] ?? "").trim()}`,
      workId: Number(work.id), workTitle: String(work.title),
      partyId: Number(party.id), partyName: String(party.name),
      agreementId,
      termStart: csvDate(row["開始日"]), termEnd: csvDate(row["終了日"]),
      currency: (String(row["通貨"] ?? "").trim() || "JPY").toUpperCase(),
      paymentTerms: String(row["支払条件"] ?? "").trim() || null,
      notes: String(row["備考"] ?? "").trim() || null,
      scopes,
      row: {
        usageType, ratePct, exclusivity: exclText ? EXCLUSIVITY[exclText] : "non_exclusive",
        mgAmount: csvAmount(row["MG"]) ?? null, agAmount: csvAmount(row["AG"]) ?? null,
        sublicensee, purpose
      }
    };
  }


  /**
   * 既に登録してある利用許諾条件に、CSV に書いてある列だけを当てる。
   *
   * 当てる先は条件番号。無ければ 作品（作品コード／作品名）＋取引モデルで当てる
   * （条件名の規則がそのまま鍵になる）。再許諾は相手ごとに何本も立つので、
   * 再許諾先も見る。それでも2本以上当たれば、条件番号で指定してもらう。
   *
   * 空欄の列は触らない。作品・許諾者・契約・通貨は替えない（条件の identity が
   * 変わってしまう。付け替えは条件の画面で）。
   */
  private async conditionUpdate(row: Record<string, string>, dryRun: boolean, actor: string):
    Promise<Omit<RowOutcome, "line">> {
    const text = (header: string) => String(row[header] ?? "").trim() || null;
    const conditionNo = text("条件番号");
    let hits: Array<{ id: number; condition_no: string | null; name: string; status: string }>;
    let label: string;

    if (conditionNo) {
      const r = await this.database.query(
        `SELECT id, condition_no, name, status FROM conditions
          WHERE lower(btrim(condition_no)) = lower(btrim($1)) LIMIT 2`, [conditionNo]);
      hits = r.rows as typeof hits;
      label = conditionNo;
      if (!hits.length) throw new DomainError("NOT_FOUND", `条件番号 ${conditionNo} が見つかりません`);
    } else {
      const usageType = parseUsageType(row["取引モデル"]);
      if (!usageType) {
        throw new DomainError("VALIDATION",
          `条件番号が無い行は「取引モデル」で当てます。「自社製造・自社販売」「再許諾」「自社製造・他社販売」「紙出版」「電子出版」のいずれかです（"${String(row["取引モデル"] ?? "").trim()}"）`);
      }
      const work = await this.findOne(
        `SELECT id, title FROM works
          WHERE ($1 <> '' AND lower(btrim(work_code)) = lower(btrim($1)))
             OR ($2 <> '' AND (btrim(title) = btrim($2) OR btrim(COALESCE(title_kana, '')) = btrim($2)))
          LIMIT 3`,
        [String(row["作品コード"] ?? "").trim(), String(row["作品名"] ?? "").trim()],
        `作品「${String(row["作品コード"] ?? row["作品名"] ?? "").trim()}」`);
      label = `${String(work.title)} ／ ${String(row["取引モデル"] ?? "").trim()}`;
      const sublicensee = text("再許諾先") ?? "";
      const r = await this.database.query(
        `SELECT c.id, c.condition_no, c.name, c.status FROM conditions c
          WHERE c.work_id = $1 AND c.usage_type = $2
            AND c.status IN ('active', 'scheduled')
            AND ($3 = '' OR c.name ILIKE '%' || $3 || '%')
          ORDER BY c.id LIMIT 3`, [Number(work.id), usageType, sublicensee]);
      hits = r.rows as typeof hits;
      if (!hits.length) {
        throw new DomainError("NOT_FOUND",
          `${label} の条件が見つかりません。先に登録するか、条件番号で指定してください`);
      }
    }
    if (hits.length > 1) {
      throw new DomainError("VALIDATION", `${label} に当たる条件が複数あります。条件番号で指定してください`);
    }
    const condition = hits[0];
    const who = `${condition.condition_no ?? `#${condition.id}`} ${condition.name}`;
    if (condition.status === "void") {
      throw new DomainError("CONFLICT", `${who} は無効化されています。直せません`);
    }
    if (condition.status === "superseded") {
      throw new DomainError("CONFLICT", `${who} は旧版です。最新版を指定してください`);
    }

    const patch: EconomicsPatch = {};
    const changed: string[] = [];
    const put = <K extends keyof EconomicsPatch>(header: string, key: K, value: EconomicsPatch[K]) => {
      patch[key] = value; changed.push(header);
    };
    const rateText = text("料率");
    if (rateText) {
      const ratePct = Number(rateText.replace(/[%％]/g, ""));
      if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
        throw new DomainError("VALIDATION", `料率は 0〜100（%）で入れてください（"${rateText}"）`);
      }
      put("料率", "ratePpm", Math.round(ratePct * 10000));
    }
    const exclText = text("独占");
    if (exclText) {
      if (!EXCLUSIVITY[exclText]) {
        throw new DomainError("VALIDATION", `独占は「独占」か「非独占」です（"${exclText}"）`);
      }
      put("独占", "exclusivity", EXCLUSIVITY[exclText]);
    }
    if (text("MG")) put("MG", "mgAmount", csvAmount(row["MG"]) ?? null);
    if (text("AG")) put("AG", "agAmount", csvAmount(row["AG"]) ?? null);
    const termStart = text("開始日");
    if (termStart) put("開始日", "termStart", csvDate(row["開始日"]));
    const termEnd = text("終了日");
    if (termEnd) put("終了日", "termEnd", csvDate(row["終了日"]));
    const paymentTerms = text("支払条件");
    if (paymentTerms) put("支払条件", "paymentTerms", paymentTerms);
    const notes = text("備考");
    if (notes) put("備考", "notes", notes);

    // 地域・言語。媒体（紙・電子）は条件の素性なので残す。
    const regionText = text("地域");
    const languageText = text("言語");
    let scopes: ConditionScope[] | null = null;
    if (regionText || languageText) {
      const cur = await this.database.query(
        "SELECT scope_type, label, code FROM condition_scopes WHERE condition_id = $1 ORDER BY sort_order, id",
        [Number(condition.id)]);
      const keep = (cur.rows as Array<Record<string, any>>)
        .filter((s) => String(s.scope_type) !== (regionText ? "region" : "")
                    && String(s.scope_type) !== (languageText ? "language" : ""))
        .map((s) => ({ scopeType: String(s.scope_type) as ConditionScope["scopeType"],
                       label: String(s.label), code: s.code ?? null }));
      scopes = [
        ...keep,
        ...(regionText ? parseRegions(regionText).map((s) => ({ scopeType: "region" as const, label: s.name, code: s.code || null })) : []),
        ...(languageText ? parseLanguages(languageText).map((s) => ({ scopeType: "language" as const, label: s.name, code: s.code || null })) : [])
      ];
      if (regionText) changed.push("地域");
      if (languageText) changed.push("言語");
    }

    if (!changed.length) {
      return { status: "skip", label, id: Number(condition.id), code: condition.condition_no,
               message: `${who}：当てる項目がありません（空欄の列は触りません）` };
    }
    const what = changed.join("・");
    if (dryRun) {
      return { status: "ok", label, id: Number(condition.id), code: condition.condition_no,
               message: `${who} の ${what} を更新します` };
    }
    if (Object.keys(patch).length) {
      // 効き始める日は指定しない（その場で直す）。改訂として版を分けたいときは
      // 条件の画面から。
      await this.conditions.updateEconomics(Number(condition.id), patch, actor, null);
    }
    if (scopes) await this.conditions.replaceScopes(Number(condition.id), scopes, actor);
    return { status: "ok", label, id: Number(condition.id), code: condition.condition_no,
             message: `${who} の ${what} を更新しました` };
  }

  private async findOne(sql: string, params: unknown[], what: string): Promise<Record<string, unknown>> {
    if (params.every((p) => String(p ?? "") === "")) throw new DomainError("VALIDATION", `${what}が空です`);
    const r = await this.database.query(sql, params);
    if (r.rows.length === 1) return r.rows[0] as Record<string, unknown>;
    throw new DomainError("VALIDATION", r.rows.length
      ? `${what}が複数当たります。コードで指定してください`
      : `${what}が見つかりません。先に登録してください`);
  }
}
