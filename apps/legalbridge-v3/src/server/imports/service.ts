import type { Transactable } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { PartyWriteService } from "../parties/write-service.js";
import { WorkWriteService } from "../works/write-service.js";
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

export type ImportKind = "parties" | "works";

export interface ImportSpec {
  kind: ImportKind;
  label: string;
  /** 必須の見出し。 */
  required: string[];
  /** 任意の見出し。 */
  optional: string[];
  sample: string;
}

export const IMPORT_SPECS: ImportSpec[] = [
  {
    kind: "parties", label: "取引先",
    required: ["名称", "区分"],
    optional: ["カナ", "インボイス番号", "法人番号", "源泉対象", "別名"],
    sample: "名称,区分,カナ,インボイス番号,法人番号,源泉対象,別名\n" +
            "株式会社甲,法人,カブシキガイシャコウ,T1234567890123,1234567890123,,甲社\n" +
            "山田太郎,個人,ヤマダタロウ,,,対象,やまだ"
  },
  {
    kind: "works", label: "作品",
    required: ["作品名"],
    optional: ["カナ", "種別", "状態", "事業区分", "備考"],
    sample: "作品名,カナ,種別,状態,事業区分,備考\n" +
            "新作ボードゲーム,シンサクボードゲーム,自社作品,企画中,ゲーム,\n" +
            "原作小説,ゲンサクショウセツ,原作IP,発売済,出版,"
  }
];

export interface RowOutcome {
  /** 1 始まり。見出しを除いた行番号ではなく、ファイル上の行番号。 */
  line: number;
  status: "ok" | "duplicate" | "error";
  label: string;
  message?: string;
  id?: number;
  code?: string | null;
}

export interface ImportReport {
  kind: ImportKind;
  dryRun: boolean;
  total: number;
  ok: number;
  duplicate: number;
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

export class ImportService {
  private readonly parties: PartyWriteService;
  private readonly works: WorkWriteService;

  constructor(private readonly database: Transactable) {
    this.parties = new PartyWriteService(database);
    this.works = new WorkWriteService(database);
  }

  async run(input: {
    kind: ImportKind; csv: string; dryRun: boolean; actor: string;
  }): Promise<ImportReport> {
    const spec = IMPORT_SPECS.find((s) => s.kind === input.kind);
    if (!spec) throw new DomainError("VALIDATION", `取り込めない種類です: ${input.kind}`);

    const parsed = parseCsv(input.csv);
    const missing = spec.required.filter((h) => !parsed.headers.includes(h));
    if (missing.length) {
      throw new DomainError("VALIDATION",
        `見出しが足りません: ${missing.join(", ")}。1行目に見出しを入れてください`);
    }

    const rows: RowOutcome[] = [];
    for (const [index, row] of parsed.rows.entries()) {
      const line = index + 2;   // 1行目は見出し
      try {
        const outcome = input.kind === "parties"
          ? await this.party(row, input.dryRun, input.actor)
          : await this.work(row, input.dryRun, input.actor);
        rows.push({ line, ...outcome });
      } catch (error) {
        const e = error as DomainError;
        rows.push({
          line,
          status: e?.code === "CONFLICT" ? "duplicate" : "error",
          label: String(row[spec.required[0]] ?? ""),
          message: e?.message ?? "登録に失敗しました"
        });
      }
    }

    return {
      kind: input.kind, dryRun: input.dryRun, total: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      duplicate: rows.filter((r) => r.status === "duplicate").length,
      error: rows.filter((r) => r.status === "error").length,
      rows
    };
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
      name, kind,
      nameKana: row["カナ"] || null,
      invoiceNo: row["インボイス番号"] || null,
      corporateNo: row["法人番号"] || null,
      withholding: csvBoolean(row["源泉対象"]) ?? false,
      aliases: String(row["別名"] ?? "").split(/[,、\/]/).map((a) => a.trim()).filter(Boolean)
    }, actor);
    return { status: "ok", label: name, id: created.id, code: created.partyCode };
  }

  private async work(row: Record<string, string>, dryRun: boolean, actor: string):
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
      kind: kindText ? WORK_KIND[kindText] : "own",
      status: statusText ? WORK_STATUS[statusText] : "planning",
      businessLine: row["事業区分"] || null,
      remarks: row["備考"] || null
    }, actor);
    return { status: "ok", label: title, id: created.id, code: created.workCode };
  }
}
