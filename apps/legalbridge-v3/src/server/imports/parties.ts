import type { Transactable } from "../core/db.js";
import { DomainError } from "../core/errors.js";
import { toCsv } from "../exports/csv.js";
import type { BankAccountInput, ContactInput, PartyInput } from "../parties/write-service.js";
import { csvBoolean } from "./parse.js";
import type { RowOutcome } from "./service.js";

/**
 * 取引先の一括登録・一括修正。
 *
 * 列は取引先の画面（登録・修正のフォームと口座の欄）と同じ項目にそろえる。
 * r1 の取込は名称・区分・カナ・番号・主担当しか持たず、住所・電話・非居住者・
 * 口座は 1 件ずつ画面で入れるしかなかった。直す取込も無かった。
 *
 *   新しく作る      … 名称・区分が要る。口座の列があれば口座も入れる。
 *   登録済みに当てる … 取引先コード（無ければ名称）で当て、書いてある列だけ直す。
 *                      今の値と同じ列は触らない（書き出しをそのまま戻しても何も起きない）。
 *
 * 口座は書き出し・取込とも admin / legal だけ（ルート側で絞る）。監査に口座の値は
 * 残さない（PartyWriteService.saveBankAccount が項目名だけ残す）。
 */

export const PARTY_BASE_HEADERS = [
  "取引先コード", "名称", "区分", "カナ", "別名", "インボイス番号", "法人番号",
  "代表者肩書", "代表者氏名", "住所", "電話", "メール",
  "主担当氏名", "主担当メール", "主担当部署",
  "源泉対象", "居住区分", "居住国", "条約税率", "条約書類受領日", "条約メモ", "状態"
] as const;

export const PARTY_BANK_HEADERS = [
  "口座区分", "銀行名", "支店名", "口座種別", "口座番号", "口座名義カナ",
  "受取人名", "SWIFT", "IBAN", "Routing", "銀行の国", "銀行の住所", "受取通貨", "中継銀行", "中継銀行SWIFT"
] as const;

export const PARTY_HEADERS = [...PARTY_BASE_HEADERS, ...PARTY_BANK_HEADERS];

/** 登録済みに当てるとき書き換えられる列（当てる手がかりの 取引先コード は除く）。 */
export const PARTY_UPDATE_COLUMNS = PARTY_HEADERS.filter((h) => h !== "取引先コード");

export const PARTIES_SAMPLE =
  "名称,区分,取引先コード,カナ,インボイス番号,法人番号,別名,代表者肩書,代表者氏名,住所,電話,メール,主担当氏名,主担当メール,主担当部署,源泉対象,居住区分,居住国,条約税率,条約書類受領日,条約メモ,口座区分,銀行名,支店名,口座種別,口座番号,口座名義カナ,受取人名,SWIFT,IBAN,Routing,銀行の国,受取通貨\n" +
  "株式会社甲,法人,,カブシキガイシャコウ,T1234567890123,1234567890123,甲社,代表取締役,甲野 一郎,東京都千代田区神田1-1-1,03-0000-0000,info@example.co.jp,乙山 花子,otoyama@example.co.jp,制作部,,,,,,,国内,みずほ銀行,神保町支店,普通,1234567,カ）コウ,,,,,,\n" +
  "山田太郎,個人,V-0102,ヤマダタロウ,,,やまだ,,,,,,,,,対象,,,,,,,,,,,,,,,,,\n" +
  "EXAMPLE STUDIO LLC,法人,,,,,,,,1 Example Street New York,,,,,,対象,非居住者,United States,0,2026-10-01,日米租税条約 12 条,海外,EXAMPLE BANK N.A.,,,000111222333,,EXAMPLE STUDIO LLC,EXAMUS33,,000000001,US,USD";

export const PARTIES_UPDATE_SAMPLE =
  "取引先コード,住所,電話,居住区分,居住国\n" +
  "PTY-2026-0001,東京都千代田区神田1-1-1,03-0000-0000,,\n" +
  "V-0102,,,非居住者,Singapore";

export const PARTIES_UPDATE_HINT =
  "当てる先は 取引先コード（無ければ 名称。同名が 2 件以上あればコードで）。" +
  "取引先コードで当てたときは 名称 を書けば名前を直します。" +
  "主担当の列は主担当の印が付いた連絡先を直し、いなければ 1 人足します。" +
  "口座の列は書いた項目だけ直し、ほかの項目は今のまま残します。" +
  "今の値と同じ列は触らないので、「登録済みの取引先」を書き出して直した列だけ変えて戻すのが早道です";

type PartyFields = Partial<PartyInput> & { status?: "active" | "archived" };

interface ParsedRow {
  party: PartyFields;
  contact: { name?: string; email?: string; department?: string };
  bank: BankAccountInput;
}

const has = (row: Record<string, string>, h: string) => String(row[h] ?? "").trim() !== "";
const get = (row: Record<string, string>, h: string) => String(row[h] ?? "").trim();

const KIND: Record<string, "corporate" | "individual"> = {
  "法人": "corporate", corporate: "corporate", "個人": "individual", individual: "individual"
};
const RESIDENCY: Record<string, "resident" | "non_resident"> = {
  "居住者": "resident", "国内": "resident", resident: "resident",
  "非居住者": "non_resident", "海外": "non_resident", non_resident: "non_resident", "non-resident": "non_resident"
};
const STATUS: Record<string, "active" | "archived"> = {
  "取引中": "active", active: "active", "取引終了": "archived", "終了": "archived", archived: "archived"
};
const SCOPE: Record<string, "domestic" | "overseas"> = {
  "国内": "domestic", domestic: "domestic", "海外": "overseas", overseas: "overseas"
};

function pick<T>(table: Record<string, T>, value: string, label: string, choices: string): T {
  const hit = table[value] ?? table[value.toLowerCase()];
  if (hit === undefined) throw new DomainError("VALIDATION", `${label}は ${choices} のどれかです（"${value}"）`);
  return hit;
}

/** 2026/1/5・2026-1-5 → 2026-01-05。 */
function csvDate(value: string, label: string): string {
  const m = value.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) throw new DomainError("VALIDATION", `${label}は 2026-10-01 の形で書いてください（"${value}"）`);
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    throw new DomainError("VALIDATION", `${label}が日付になっていません（"${value}"）`);
  }
  return iso;
}

/** 1 行を取引先・主担当・口座の入力へ。空欄の列は入れない（＝触らない）。 */
export function parsePartyRow(row: Record<string, string>): ParsedRow {
  const party: PartyFields = {};
  const text = (h: string, key: keyof PartyInput) => {
    if (has(row, h)) (party as Record<string, unknown>)[key] = get(row, h);
  };
  if (has(row, "名称")) party.name = get(row, "名称");
  if (has(row, "区分")) party.kind = pick(KIND, get(row, "区分"), "区分", "法人・個人");
  text("カナ", "nameKana");
  if (has(row, "別名")) party.aliases = get(row, "別名").split(/[,、\/／]/).map((a) => a.trim()).filter(Boolean);
  text("インボイス番号", "invoiceNo");
  text("法人番号", "corporateNo");
  text("代表者肩書", "representativeTitle");
  text("代表者氏名", "representativeName");
  text("住所", "address");
  text("電話", "phone");
  text("メール", "email");
  if (has(row, "源泉対象")) {
    const w = csvBoolean(get(row, "源泉対象"));
    if (w === undefined) throw new DomainError("VALIDATION", `源泉対象は「対象」か「対象外」です（"${get(row, "源泉対象")}"）`);
    party.withholding = w;
  }
  if (has(row, "居住区分")) party.residency = pick(RESIDENCY, get(row, "居住区分"), "居住区分", "居住者・非居住者");
  text("居住国", "residenceCountry");
  if (has(row, "条約税率")) {
    const raw = get(row, "条約税率").replace(/[%％\s]/g, "");
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || n < 0 || n > 100) {
      throw new DomainError("VALIDATION", `条約税率は 0〜100 の数です（"${get(row, "条約税率")}"）`);
    }
    party.treatyRatePct = n;
  }
  if (has(row, "条約書類受領日")) party.treatyDocsReceivedOn = csvDate(get(row, "条約書類受領日"), "条約書類受領日");
  text("条約メモ", "treatyNote");
  if (has(row, "状態")) party.status = pick(STATUS, get(row, "状態"), "状態", "取引中・取引終了");

  const contact: ParsedRow["contact"] = {};
  if (has(row, "主担当氏名")) contact.name = get(row, "主担当氏名");
  if (has(row, "主担当メール")) contact.email = get(row, "主担当メール");
  if (has(row, "主担当部署")) contact.department = get(row, "主担当部署");

  const bank: BankAccountInput = {};
  const b = (h: string, key: keyof BankAccountInput, transform?: (v: string) => string) => {
    if (has(row, h)) (bank as Record<string, unknown>)[key] = transform ? transform(get(row, h)) : get(row, h);
  };
  if (has(row, "口座区分")) bank.accountScope = pick(SCOPE, get(row, "口座区分"), "口座区分", "国内・海外");
  b("銀行名", "bankName");
  b("支店名", "branchName");
  b("口座種別", "accountType");
  b("口座番号", "accountNumber");
  b("口座名義カナ", "accountHolderKana");
  b("受取人名", "accountHolderName");
  b("SWIFT", "swiftBic", (v) => v.toUpperCase().replace(/\s/g, ""));
  b("IBAN", "iban", (v) => v.toUpperCase().replace(/\s/g, ""));
  b("Routing", "routingNumber");
  b("銀行の国", "bankCountry", (v) => {
    const c = v.toUpperCase();
    if (!/^[A-Z]{2}$/.test(c)) throw new DomainError("VALIDATION", `銀行の国は国コード 2 文字です（US・GB など。"${v}"）`);
    return c;
  });
  b("銀行の住所", "bankAddress");
  b("受取通貨", "currency", (v) => {
    const c = v.toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new DomainError("VALIDATION", `受取通貨は通貨コード 3 文字です（USD・EUR など。"${v}"）`);
    return c;
  });
  b("中継銀行", "intermediaryBankName");
  b("中継銀行SWIFT", "intermediaryBankSwift", (v) => v.toUpperCase().replace(/\s/g, ""));
  return { party, contact, bank };
}

const OVERSEAS_KEYS = [
  "accountHolderName", "swiftBic", "iban", "routingNumber", "bankCountry", "bankAddress",
  "currency", "intermediaryBankSwift", "intermediaryBankName"
] as const;
const DOMESTIC_KEYS = ["bankName", "branchName", "accountType", "accountNumber", "accountHolderKana"] as const;

/** 口座の入力名 → party_bank_accounts の列名。 */
const BANK_COLUMN: Record<string, string> = {
  bankName: "bank_name", branchName: "branch_name", accountType: "account_type",
  accountNumber: "account_number", accountHolderKana: "account_holder_kana",
  accountScope: "account_scope", accountHolderName: "account_holder_name", swiftBic: "swift_bic",
  iban: "iban", routingNumber: "routing_number", bankCountry: "bank_country", bankAddress: "bank_address",
  currency: "currency", intermediaryBankSwift: "intermediary_bank_swift", intermediaryBankName: "intermediary_bank_name"
};

/** 取引先の入力名 → parties の列名。今の値と比べるのに使う。 */
const PARTY_COLUMN: Record<string, string> = {
  name: "name", kind: "kind", nameKana: "name_kana", aliases: "aliases", invoiceNo: "invoice_no",
  corporateNo: "corporate_no", representativeTitle: "representative_title",
  representativeName: "representative_name", address: "address", phone: "phone", email: "email",
  withholding: "withholding", residency: "residency", residenceCountry: "residence_country",
  treatyRatePct: "treaty_rate_pct", treatyDocsReceivedOn: "treaty_docs_received_on",
  treatyNote: "treaty_note", status: "status"
};

/** 結果の文に出す名前。 */
const LABEL: Record<string, string> = {
  name: "名称", kind: "区分", nameKana: "カナ", aliases: "別名", invoiceNo: "インボイス番号",
  corporateNo: "法人番号", representativeTitle: "代表者肩書", representativeName: "代表者氏名",
  address: "住所", phone: "電話", email: "メール", withholding: "源泉対象", residency: "居住区分",
  residenceCountry: "居住国", treatyRatePct: "条約税率", treatyDocsReceivedOn: "条約書類受領日",
  treatyNote: "条約メモ", status: "状態"
};

function same(current: unknown, next: unknown): boolean {
  if (Array.isArray(next)) {
    const cur = Array.isArray(current) ? current.map(String) : [];
    return cur.length === next.length && cur.every((v, i) => v === String(next[i]));
  }
  if (typeof next === "boolean") return (current === true) === next;
  if (typeof next === "number") return current !== null && current !== undefined && Number(current) === next;
  const cur = current === null || current === undefined ? ""
    : current instanceof Date ? current.toISOString().slice(0, 10) : String(current);
  // 日付は時刻付きで返ることがある。
  return (/^\d{4}-\d{2}-\d{2}/.test(String(next)) ? cur.slice(0, 10) : cur).trim() === String(next).trim();
}

export interface PartiesImportDeps {
  parties: {
    create(input: PartyInput, actor: string): Promise<{ id: number; partyCode: string | null }>;
    update(id: number, input: PartyFields, actor: string): Promise<unknown>;
    saveBankAccount(partyId: number, input: BankAccountInput, actor: string): Promise<unknown>;
    addContact(partyId: number, input: ContactInput, actor: string): Promise<{ id: number }>;
    updateContact(partyId: number, contactId: number, input: ContactInput, actor: string): Promise<{ id: number }>;
  };
}

export class PartiesImportService {
  private overseasReady: boolean | undefined;

  constructor(private readonly database: Transactable, private readonly deps: PartiesImportDeps) {}

  /** 海外送金の列（A-051）がデータベースにあるか。無いのに海外の列を書くと UPDATE が落ちる。 */
  private async requireOverseas(bank: BankAccountInput): Promise<void> {
    const wants = OVERSEAS_KEYS.some((k) => bank[k] !== undefined) || bank.accountScope === "overseas";
    if (!wants) return;
    if (this.overseasReady === undefined) {
      const r = await this.database.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'party_bank_accounts' AND column_name = 'swift_bic'
            AND table_schema = ANY (current_schemas(false))`);
      this.overseasReady = Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0) > 0;
    }
    if (!this.overseasReady) {
      throw new DomainError("VALIDATION", "海外口座の列（SWIFT など）がまだデータベースにありません。国内の口座の列だけで取り込んでください");
    }
  }

  /** 新しく作る。同名・同じコードは飛ばす（duplicate）。 */
  async create(row: Record<string, string>, dryRun: boolean, actor: string): Promise<Omit<RowOutcome, "line">> {
    const name = get(row, "名称");
    if (!name) throw new DomainError("VALIDATION", "名称が空です");
    if (!has(row, "区分")) throw new DomainError("VALIDATION", "区分は「法人」か「個人」です（空です）");
    const { party, contact, bank } = parsePartyRow(row);
    if (party.status === "archived") throw new DomainError("VALIDATION", "新しく作る取引先を「取引終了」にはできません");
    await this.requireOverseas(bank);

    // 取引先コード。空なら自動採番。書いてあれば他と重ならないことを確かめる。
    const partyCode = get(row, "取引先コード") || null;
    if (partyCode) {
      const taken = await this.database.query(
        "SELECT id, name FROM parties WHERE lower(btrim(party_code)) = lower(btrim($1)) LIMIT 1", [partyCode]);
      const hit = taken.rows[0] as { id: number; name: string } | undefined;
      if (hit) throw new DomainError("CONFLICT", `取引先コード ${partyCode} は既に「${hit.name}」で使われています`);
    }
    const hasBank = Object.keys(bank).length > 0;

    if (dryRun) {
      // 書かずに、同名が既にいるかだけ確かめる。
      const sameName = await this.database.query(
        "SELECT id, party_code FROM parties WHERE btrim(name) = btrim($1) AND status <> 'merged' LIMIT 1",
        [name]);
      const hit = sameName.rows[0] as { id: number; party_code: string | null } | undefined;
      if (hit) {
        return { status: "duplicate", label: name,
                 message: `同名が既にあります（${hit.party_code ?? `#${hit.id}`}）。この行は飛ばされます`,
                 id: Number(hit.id) };
      }
      return { status: "ok", label: name, ...(hasBank ? { message: "口座も登録します" } : {}) };
    }

    const created = await this.deps.parties.create({
      ...party, name, kind: party.kind!, partyCode,
      withholding: party.withholding ?? false,
      aliases: party.aliases ?? [],
      primaryContact: { name: contact.name ?? null, email: contact.email ?? null, department: contact.department ?? null }
    }, actor);
    if (hasBank) await this.deps.parties.saveBankAccount(created.id, bank, actor);
    return { status: "ok", label: name, id: created.id, code: created.partyCode,
             ...(hasBank ? { message: "口座も登録しました" } : {}) };
  }

  /** 取引先コード（無ければ名称）で当てて、書いてある列のうち今と違うものだけ直す。 */
  async update(row: Record<string, string>, dryRun: boolean, actor: string): Promise<Omit<RowOutcome, "line">> {
    const code = get(row, "取引先コード");
    const byName = !code;
    const key = code || get(row, "名称");
    if (!key) throw new DomainError("VALIDATION", "取引先コードも名称も空です。どの取引先を直すかが決まりません");

    const found = await this.database.query(
      byName
        ? "SELECT to_jsonb(p) AS row FROM parties p WHERE btrim(p.name) = btrim($1) AND p.status <> 'merged' ORDER BY p.id LIMIT 2"
        : "SELECT to_jsonb(p) AS row FROM parties p WHERE lower(btrim(p.party_code)) = lower(btrim($1)) LIMIT 2",
      [key]);
    const hits = (found.rows as Array<{ row: Record<string, any> }>).map((r) => r.row);
    if (!hits.length) {
      throw new DomainError("VALIDATION", byName
        ? `名称「${key}」の取引先が見つかりません（名前を直すときは取引先コードで当ててください）`
        : `取引先コード ${key} が見つかりません`);
    }
    if (hits.length > 1) {
      throw new DomainError("VALIDATION", `名称「${key}」の取引先が 2 件以上あります。取引先コードで当ててください`);
    }
    const current = hits[0];
    const id = Number(current.id);
    const label = String(current.name ?? key);
    if (current.status === "merged") {
      throw new DomainError("VALIDATION", `${label} は統合されています。統合先を直してください`);
    }

    const { party, contact, bank } = parsePartyRow(row);
    if (byName) delete party.name;   // 名称で当てたときの名称は手がかりで、直す値ではない

    // 取引先の列：今と違うものだけ。
    const fields: PartyFields = {};
    for (const [k, v] of Object.entries(party)) {
      if (!same(current[PARTY_COLUMN[k]], v)) (fields as Record<string, unknown>)[k] = v;
    }
    const kind = (fields.kind ?? current.kind) as string;
    if (kind === "individual" && (fields.representativeTitle !== undefined || fields.representativeName !== undefined)) {
      // 個人は代表者を持たない（フォームも出さない）。
      delete fields.representativeTitle; delete fields.representativeName;
    }
    const changed = Object.keys(fields).map((k) => LABEL[k] ?? k);

    // 主担当：主担当の印が付いた最初の連絡先。
    let contactPlan: { id?: number; input: ContactInput } | null = null;
    if (Object.keys(contact).length) {
      const c = await this.database.query(
        `SELECT id, name, email, department FROM party_contacts
          WHERE party_id = $1 AND 'primary' = ANY(roles) ORDER BY id LIMIT 1`, [id]);
      const hit = c.rows[0] as Record<string, any> | undefined;
      const input: ContactInput = {};
      for (const [k, v] of Object.entries(contact)) {
        if (!hit || !same(hit[k], v)) (input as Record<string, unknown>)[k] = v;
      }
      if (Object.keys(input).length) {
        if (!hit && !input.name && !input.email) {
          throw new DomainError("VALIDATION", "主担当がまだいません。足すときは主担当氏名か主担当メールを書いてください");
        }
        contactPlan = hit ? { id: Number(hit.id), input } : { input: { ...input, roles: ["primary"] } };
        changed.push(hit ? "主担当" : "主担当（追加）");
      }
    }

    // 口座：書いた項目だけ今と違えば直す。国内の 5 項目は保存で全部書き直されるので、
    // 書いていない項目は今の値を入れて渡す（消さない）。
    let bankPlan: BankAccountInput | null = null;
    if (Object.keys(bank).length) {
      await this.requireOverseas(bank);
      const r = await this.database.query(
        "SELECT to_jsonb(b) AS row FROM party_bank_accounts b WHERE b.party_id = $1", [id]);
      const now = (r.rows[0] as { row?: Record<string, any> } | undefined)?.row ?? {};
      const diff = Object.entries(bank).filter(([k, v]) => {
        const cur = now[BANK_COLUMN[k]];
        // 口座区分は空なら国内。
        return !same(k === "accountScope" ? (cur ?? "domestic") : cur, v);
      });
      if (diff.length) {
        const input: BankAccountInput = {};
        for (const k of DOMESTIC_KEYS) input[k] = (now[BANK_COLUMN[k]] ?? null) as string | null;
        for (const [k, v] of diff) (input as Record<string, unknown>)[k] = v;
        bankPlan = input;
        changed.push("口座");
      }
    }

    if (!changed.length) return { status: "skip", label, id, code: current.party_code ?? null, message: "変更なし" };
    if (!dryRun) {
      if (Object.keys(fields).length) await this.deps.parties.update(id, fields, actor);
      if (contactPlan) {
        if (contactPlan.id) await this.deps.parties.updateContact(id, contactPlan.id, contactPlan.input, actor);
        else await this.deps.parties.addContact(id, contactPlan.input, actor);
      }
      if (bankPlan) await this.deps.parties.saveBankAccount(id, bankPlan, actor);
    }
    return { status: "ok", label, id, code: current.party_code ?? null,
             message: `${changed.join("・")} を${dryRun ? "更新します" : "更新しました"}` };
  }

  /** 登録済みの取引先を、取込と同じ列で書き出す（統合済みは除く）。口座も含む。 */
  async exportCsv(): Promise<string> {
    const r = await this.database.query(
      `SELECT to_jsonb(p) AS party,
              (SELECT to_jsonb(c) FROM party_contacts c
                WHERE c.party_id = p.id AND 'primary' = ANY(c.roles) ORDER BY c.id LIMIT 1) AS contact,
              (SELECT to_jsonb(b) FROM party_bank_accounts b WHERE b.party_id = p.id) AS bank
         FROM parties p
        WHERE p.status <> 'merged'
        ORDER BY p.party_code NULLS LAST, p.name, p.id`);
    const s = (v: unknown) => v === null || v === undefined ? "" : String(v);
    const rows = (r.rows as Array<{ party: Record<string, any>; contact: Record<string, any> | null;
                                     bank: Record<string, any> | null }>).map(({ party: p, contact: c, bank: b }) => {
      const rate = p.treaty_rate_pct;
      const out: Record<string, string> = {
        "取引先コード": s(p.party_code), "名称": s(p.name), "区分": p.kind === "individual" ? "個人" : "法人",
        "カナ": s(p.name_kana), "別名": (Array.isArray(p.aliases) ? p.aliases : []).join("、"),
        "インボイス番号": s(p.invoice_no), "法人番号": s(p.corporate_no),
        "代表者肩書": s(p.representative_title), "代表者氏名": s(p.representative_name),
        "住所": s(p.address), "電話": s(p.phone), "メール": s(p.email),
        "主担当氏名": s(c?.name), "主担当メール": s(c?.email), "主担当部署": s(c?.department),
        "源泉対象": p.withholding === true ? "対象" : "対象外",
        "居住区分": p.residency === "non_resident" ? "非居住者" : "居住者",
        "居住国": s(p.residence_country),
        "条約税率": rate === null || rate === undefined ? "" : String(Number(rate)),
        "条約書類受領日": s(p.treaty_docs_received_on).slice(0, 10), "条約メモ": s(p.treaty_note),
        "状態": p.status === "archived" ? "取引終了" : "取引中"
      };
      for (const h of PARTY_BANK_HEADERS) out[h] = "";
      if (b) {
        Object.assign(out, {
          "口座区分": b.account_scope === "overseas" ? "海外" : "国内",
          "銀行名": s(b.bank_name), "支店名": s(b.branch_name), "口座種別": s(b.account_type),
          "口座番号": s(b.account_number), "口座名義カナ": s(b.account_holder_kana),
          "受取人名": s(b.account_holder_name), "SWIFT": s(b.swift_bic), "IBAN": s(b.iban),
          "Routing": s(b.routing_number), "銀行の国": s(b.bank_country), "銀行の住所": s(b.bank_address),
          "受取通貨": s(b.currency), "中継銀行": s(b.intermediary_bank_name), "中継銀行SWIFT": s(b.intermediary_bank_swift)
        });
      }
      return out;
    });
    return toCsv(PARTY_HEADERS.map((h) => ({ header: h, value: (row: Record<string, string>) => row[h] })), rows);
  }
}
