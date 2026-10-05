import { type Transactable, inTransaction, dateStr, int, str } from "../core/db.js";
import { DomainError, translate } from "../core/errors.js";
import { recordAudit } from "../core/audit.js";
import { KIND_LABEL, type AgreementDomain, type AgreementKind } from "./service.js";
import { TERMS_IMPORT_KINDS, TERMS_TEMPLATES } from "../conditions/contracts.js";
import { agreementDatedTitle } from "../documents/legacy-variables.js";
import type { AgreementCsvRow } from "./csv.js";

/**
 * 取引先 ⇔ 基本契約のマップ。
 *
 * 取引先と基本契約を結ぶ専用の表は無い。どの画面も agreements.counterparty_id から
 * その場で導いていて、導き方が画面ごとに違う（統合を辿る／辿らない、補助文書を
 * 親に寄せる／寄せない、種類・状態で絞る／絞らない）。同じ取引先の基本契約が
 * 画面によって違って見えるのはそのため。
 *
 * ここでは取引先ひとつぶんの契約を、統合元も含めて全部引き、
 *   基本契約・単体契約 → その下の補助文書・解除合意
 * の木にして見せる。木にならないもの（親の無い補助文書、相手先の違う親、
 * 種別の無い基本契約、同じ種別の基本契約が並んでいる …）は「ずれ」として出し、
 * その場で種類・親・種別・方向・相手先を付け替えられるようにする。
 *
 * 表は増やさない。直すのは agreements の列だけ（番号は振り直さない）。
 */

export type MapIssueCode =
  | "orphan" | "parent_party_mismatch" | "parent_not_master" | "master_with_parent"
  | "no_domain" | "duplicate_master" | "standalone_with_master";

export interface MapIssue {
  code: MapIssueCode;
  agreementId: number;
  message: string;
}

export interface MapAgreement {
  id: number;
  agreementNo: string | null;
  title: string;
  kind: AgreementKind;
  domain: AgreementDomain | null;
  direction: "in" | "out";
  status: string;
  parentId: number | null;
  executedOn: string | null;
  terminatedOn: string | null;
  /** 契約が指している取引先（統合元のこともある）。 */
  counterparty: { id: number; name: string; merged: boolean };
  /** 親の契約の取引先を統合で辿った先。親が無ければ null。 */
  parentResolvedPartyId: number | null;
  parentKind: AgreementKind | null;
  conditionCount: number;
  documentCount: number;
}

export interface MapNode extends MapAgreement {
  children: MapAgreement[];
  /** 他の画面が「この取引先の基本契約」として選ぶ1本か（domain × direction ごと）。 */
  primary: boolean;
}

export interface PartyMap {
  party: { id: number; name: string };
  /** 基本契約・単体契約と、その下に正しくぶら下がっているもの。 */
  roots: MapNode[];
  /** 木に入らない補助文書・解除合意（親が無い・親が別の取引先・親が基本契約でない）。 */
  loose: MapAgreement[];
  /** 文書だけ（NDA など）。 */
  documents: MapAgreement[];
  issues: MapIssue[];
  /**
   * 契約に繋がっていない文書（契約書・覚書・NDA など、契約にあたるもの）。
   * 取り込んだだけで契約（合意）に載っていない紙を、ここから契約に繋ぐ。
   */
  unlinked: UnlinkedDocument[];
  /**
   * 契約に載っていない条件明細（取り消し・差し替え済みは除く）。契約を登録したあと、
   * ここから契約に載せる（条件のつながり「契約（合意）」と同じ）。
   */
  looseConditions: LooseCondition[];
}

export interface LooseCondition {
  id: number; conditionNo: string | null; name: string;
  kind: string; direction: "in" | "out"; status: string;
  workTitle: string | null; termStart: string | null;
}

export interface UnlinkedDocument {
  id: number; documentNo: string | null; label: string; title: string | null;
  status: string; issuedOn: string | null;
}

/**
 * 契約にあたる文書。発注書・検収書・納品書・計算書は契約の下の個別の取引で、
 * もともと契約（合意）に繋がない（agreements/service.ts の③）ので数えない。
 */
const CONTRACT_DOCUMENT_SQL = `(
  (t.template_key IS NULL
     AND COALESCE(d.manual_inputs->>'documentKind', '') NOT IN ('発注書', '発注請書', '検収書', '通知書'))
  OR t.template_key NOT IN ('purchase_order', 'intl_purchase_order', 'inspection_certificate',
                            'intl_inspection_certificate', 'delivery_note', 'acceptance_certificate',
                            'royalty_statement'))`;

/** 契約に繋がっていない契約文書の共通の条件（d・t・v を使う）。 */
const UNLINKED_WHERE = `d.agreement_id IS NULL
  AND d.status NOT IN ('void', 'superseded', 'draft')
  AND ${CONTRACT_DOCUMENT_SQL}`;

const isRootKind = (kind: AgreementKind) => kind === "master" || kind === "standalone";
const isChildKind = (kind: AgreementKind) => kind === "supplement" || kind === "termination";

export const DOMAIN_LABEL: Record<AgreementDomain, string> = { service: "業務委託", license: "ライセンス" };
const DIRECTION_LABEL = { in: "IN", out: "OUT" } as const;

const tag = (a: Pick<MapAgreement, "agreementNo" | "id">) => a.agreementNo ?? `#${a.id}`;

/** 生きている基本契約か。締結済みで、解除されていない。 */
const isLive = (a: MapAgreement) => a.status === "executed" && !a.terminatedOn;

/**
 * 取引先ひとつぶんの契約を木にする。DB を読まない（テストできるように）。
 *
 * primary は「その domain × direction で他の画面が拾うべき1本」。締結済み・未解除の
 * 基本契約のうち、締結日の新しいもの。単体契約は既定にしない（その作品・その取引
 * だけの契約で、取引先全体の準拠契約ではない）。単体契約しか無ければ既定なし。
 */
export function buildPartyMap(party: { id: number; name: string }, rows: MapAgreement[]): PartyMap {
  const issues: MapIssue[] = [];
  const roots: MapNode[] = [];
  const loose: MapAgreement[] = [];
  const documents: MapAgreement[] = [];

  for (const a of rows) {
    if (isRootKind(a.kind)) {
      if (a.parentId) {
        issues.push({ code: "master_with_parent", agreementId: a.id,
          message: `${tag(a)} は${KIND_LABEL[a.kind]}なのに親の契約を持っています（親を外すか、補助文書にしてください）` });
      }
      if (!a.domain) {
        issues.push({ code: "no_domain", agreementId: a.id,
          message: `${tag(a)} は種別（業務委託／ライセンス）が未設定です。画面によって拾われたり拾われなかったりします` });
      }
      roots.push({ ...a, children: [], primary: false });
    } else if (a.kind === "document") {
      documents.push(a);
    }
  }
  const rootIds = new Set(roots.map((r) => r.id));

  for (const a of rows) {
    if (!isChildKind(a.kind)) continue;
    if (!a.parentId) {
      issues.push({ code: "orphan", agreementId: a.id,
        message: `${tag(a)}（${KIND_LABEL[a.kind]}）に親の契約がありません` });
      loose.push(a);
      continue;
    }
    if (a.parentResolvedPartyId !== null && a.parentResolvedPartyId !== party.id) {
      issues.push({ code: "parent_party_mismatch", agreementId: a.id,
        message: `${tag(a)} の親の契約は別の取引先のものです` });
      loose.push(a);
      continue;
    }
    if (a.parentKind && !isRootKind(a.parentKind)) {
      issues.push({ code: "parent_not_master", agreementId: a.id,
        message: `${tag(a)} の親が${KIND_LABEL[a.parentKind]}です（親にできるのは基本契約か単体契約だけ）` });
      loose.push(a);
      continue;
    }
    const root = rootIds.has(a.parentId) ? roots.find((r) => r.id === a.parentId)! : null;
    if (root) root.children.push(a);
    else loose.push(a);
  }

  // domain × direction ごとに、他の画面が拾うべき1本と、並んでいる生きた基本契約。
  const groups = new Map<string, MapNode[]>();
  for (const r of roots) {
    const key = `${r.domain ?? "-"}:${r.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const list of groups.values()) {
    const live = list.filter(isLive);
    const masters = live.filter((r) => r.kind === "master");
    const pick = [...masters].sort((x, y) =>
      String(y.executedOn ?? "").localeCompare(String(x.executedOn ?? "")) || y.id - x.id)[0];
    if (pick) pick.primary = true;
    if (masters.length > 1 && pick) {
      const label = `${pick.domain ? DOMAIN_LABEL[pick.domain] : "種別未設定"}・${DIRECTION_LABEL[pick.direction]}`;
      for (const m of masters) {
        if (m.id === pick.id) continue;
        issues.push({ code: "duplicate_master", agreementId: m.id,
          message: `${label} の生きた基本契約が ${masters.length} 本あります。画面により ${tag(m)} と ${tag(pick)} のどちらが出るかが変わります（古い方を解除するか、種別・方向を直してください）` });
      }
    }
  }

  // 条件明細の載った単体契約があり、同じ向きの基本契約もある。取引は
  // （1）基本契約＋個別契約 か（2）単体契約 のどちらかなので、基本契約があるなら
  // その下の個別契約にできる（「個別契約にする」）。単体契約のままだと、文書は
  // 「基本契約なし」で出て、基本契約の条項に拠らない。
  for (const r of roots) {
    if (r.kind !== "standalone" || r.conditionCount === 0) continue;
    const masters = roots.filter((m) => m.kind === "master" && m.direction === r.direction && !m.terminatedOn);
    if (!masters.length) continue;
    const m = masters.find((x) => x.primary) ?? masters[0];
    issues.push({ code: "standalone_with_master", agreementId: r.id,
      message: `${tag(r)} は単体契約ですが、${tag(m)}（基本契約）があります。基本契約の下の個別契約にするなら「個別契約にする」` });
  }

  roots.sort((x, y) =>
    Number(y.primary) - Number(x.primary) ||
    String(x.domain ?? "~").localeCompare(String(y.domain ?? "~")) ||
    x.direction.localeCompare(y.direction) || x.id - y.id);
  for (const r of roots) r.children.sort((x, y) => x.id - y.id);

  return { party, roots, loose, documents, issues, unlinked: [], looseConditions: [] };
}

// ---------------------------------------------------------------------------
// 付け替えの検査（DB を読まない）
// ---------------------------------------------------------------------------

export interface RemapInput {
  kind?: AgreementKind;
  domain?: AgreementDomain | null;
  direction?: "in" | "out";
  parentId?: number | null;
  counterpartyId?: number;
  /**
   * 契約締結日（YYYY-MM-DD）。null で消す。
   * 未締結（下書き・交渉中）の契約に入れたら締結済みにする（日付だけ入って
   * 「交渉中」のままだと、締結済みだけを拾う画面に出てこない）。
   */
  executedOn?: string | null;
  /** 以下は CSV の一括修正から。画面の編集は使わない。 */
  title?: string;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  autoRenewal?: boolean;
  counterpartyRefNo?: string | null;
}

/** 試算（書き込まずに検証だけ）のとき、トランザクションを巻き戻すための合図。 */
class DryRunRollback extends Error {
  constructor(readonly changed: string[]) { super("dry-run"); }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RemapCurrent {
  id: number; kind: AgreementKind; domain: AgreementDomain | null; direction: "in" | "out";
  parentId: number | null; counterpartyId: number; resolvedPartyId: number; childCount: number;
}

export interface RemapParent {
  id: number; kind: AgreementKind; resolvedPartyId: number;
}

/**
 * 付け替えたあとの形を決め、通らなければ理由を投げる。
 * 基本契約・単体契約・文書だけに変えたら、親は自動で外す（親を持てない種類なので）。
 */
export function planRemap(
  current: RemapCurrent, input: RemapInput,
  parent: RemapParent | null, targetResolvedPartyId: number
): { kind: AgreementKind; domain: AgreementDomain | null; direction: "in" | "out";
     parentId: number | null; counterpartyId: number } {
  const kind = input.kind ?? current.kind;
  const domain = input.domain !== undefined ? input.domain : current.domain;
  const direction = input.direction ?? current.direction;
  const counterpartyId = input.counterpartyId ?? current.counterpartyId;
  let parentId = input.parentId !== undefined ? input.parentId : current.parentId;
  if (!isChildKind(kind)) parentId = null;

  if (current.childCount > 0 && !isRootKind(kind)) {
    throw new DomainError("VALIDATION",
      `補助文書・解除合意が ${current.childCount} 件ぶら下がっています。先にそちらの親を付け替えてください`);
  }
  if (current.childCount > 0 && targetResolvedPartyId !== current.resolvedPartyId) {
    throw new DomainError("VALIDATION",
      "ぶら下がる補助文書・解除合意があるので、相手先は変えられません（子の相手先とずれます）");
  }
  if (isRootKind(kind) && !domain) {
    throw new DomainError("VALIDATION", "基本契約・単体契約には種別（業務委託／ライセンス）を選んでください");
  }
  if (isChildKind(kind)) {
    if (!parentId) throw new DomainError("VALIDATION", "補助文書・解除合意は親の契約を選んでください");
    if (parentId === current.id) throw new DomainError("VALIDATION", "自分自身は親にできません");
    if (!parent) throw new DomainError("NOT_FOUND", `親の契約 ${parentId} が見つかりません`);
    if (!isRootKind(parent.kind)) {
      throw new DomainError("VALIDATION", "親にできるのは基本契約か単体契約だけです");
    }
    if (parent.resolvedPartyId !== targetResolvedPartyId) {
      throw new DomainError("VALIDATION", "親の契約と相手先が違います");
    }
  }
  return { kind, domain, direction, parentId, counterpartyId };
}

/** 締結日を入れたときの状態。未締結なら締結済みに進める。解除済み・締結済みはそのまま。 */
export function executedChange(status: string, executedOn: string | null)
  : { executedOn: string | null; status: string } {
  if (executedOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(executedOn)) {
    throw new DomainError("VALIDATION", "締結日は YYYY-MM-DD で入れてください");
  }
  const pending = status === "draft" || status === "negotiating";
  return { executedOn, status: executedOn && pending ? "executed" : status };
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

export interface RefDocument {
  id: number; documentNo: string; title: string; label: string; issuedOn: string | null;
}

export interface DocumentRefs {
  party: { id: number; name: string };
  /** 基本契約（単体契約は含めない）。primary は他の画面が既定で拾う1本。 */
  masters: Array<{
    id: number; agreementNo: string | null; title: string; kind: AgreementKind;
    domain: AgreementDomain | null; direction: "in" | "out"; status: string;
    executedOn: string | null; terminatedOn: string | null; primary: boolean;
    /** 文書に出る呼び方「2024年4月1日付◯◯」。 */
    datedTitle: string;
  }>;
  /** 決定済みの発注書。検収書の「発注番号」に選ぶ。 */
  purchaseOrders: RefDocument[];
  /**
   * 選んだ条件につながっている発注書（conditionIds を渡したときだけ）。
   * 条件が載っている単体契約（取り込んだ発注書を契約として登録したもの）と、
   * 条件に結びついた発注書の文書。purchaseOrders は作った発注書しか拾わないので、
   * 取り込んだ発注書に対する検収で番号が選べなかった。
   */
  linkedOrders: Array<RefDocument & { source: "agreement" | "document"; conditionNos: string[] }>;
  /** 個別契約（条件書・取り込んだ利用許諾契約書・覚書）。計算書の「契約番号」に選ぶ。 */
  terms: RefDocument[];
}

export interface MapPartyRow {
  id: number; name: string;
  total: number; roots: number; documents: number;
  /** SQL で数えられるずれ（親なし・親の相手先違い・種別なし）。重複は詳細で見る。 */
  issues: number;
  /** 契約に繋がっていない契約文書の数。 */
  unlinked: number;
  /** 契約に載っていない条件明細の数。 */
  looseConditions: number;
}

/** 契約に載っていない条件明細（取り消し・差し替え済みは数えない）。別名 co。 */
const LOOSE_CONDITION_WHERE = `co.agreement_id IS NULL AND co.status NOT IN ('superseded', 'void')`;

const MAP_SELECT = `
  SELECT a.id, a.agreement_no, a.title, a.kind, a.domain, a.direction, a.status, a.parent_id,
         a.executed_on, a.terminated_on,
         a.counterparty_id, p.name AS party_name, (r.party_id <> r.resolved_id) AS party_merged,
         pr.resolved_id AS parent_resolved_id, pa.kind AS parent_kind,
         (SELECT count(*) FROM conditions c WHERE c.agreement_id = a.id)::int AS condition_count,
         (SELECT count(*) FROM documents d WHERE d.agreement_id = a.id)::int AS document_count
    FROM agreements a
    JOIN parties p ON p.id = a.counterparty_id
    JOIN v_party_resolved r ON r.party_id = a.counterparty_id
    LEFT JOIN agreements pa ON pa.id = a.parent_id
    LEFT JOIN v_party_resolved pr ON pr.party_id = pa.counterparty_id`;

export function mapAgreementRow(row: any): MapAgreement {
  return {
    id: Number(row.id), agreementNo: str(row.agreement_no), title: String(row.title ?? ""),
    // 移行した行は kind が空のことがある。他の画面と同じく基本契約とみなす。
    kind: (str(row.kind) ?? "master") as AgreementKind,
    domain: (str(row.domain) as AgreementDomain | null) ?? null,
    direction: row.direction === "out" ? "out" : "in",
    status: String(row.status ?? ""),
    parentId: int(row.parent_id),
    executedOn: dateStr(row.executed_on), terminatedOn: dateStr(row.terminated_on),
    counterparty: { id: Number(row.counterparty_id), name: String(row.party_name ?? ""),
                    merged: row.party_merged === true },
    parentResolvedPartyId: int(row.parent_resolved_id),
    parentKind: row.parent_id ? ((str(row.parent_kind) ?? "master") as AgreementKind) : null,
    conditionCount: Number(row.condition_count ?? 0),
    documentCount: Number(row.document_count ?? 0)
  };
}

export class PartyAgreementMapService {
  constructor(private readonly database: Transactable) {}

  /** 契約を持つ取引先の一覧（統合先でまとめる）。ずれのあるものを上に。 */
  async parties(query: { keyword?: string; issuesOnly?: boolean } = {}): Promise<MapPartyRow[]> {
    const q = String(query.keyword ?? "").trim();
    try {
      // 取引先の検索は取引先の画面と同じ（名称・取引先コード・カナ・別名）。統合元に当たっても
      // 統合先を出す。打たずに開いたときは、契約か契約に繋がっていない文書のある取引先だけ。
      // 打ったときは契約の無い取引先も出す（そこから契約を登録し、文書を繋ぐ）。
      const r = await this.database.query(
        `WITH matched AS (
           SELECT DISTINCT r.resolved_id
             FROM parties p JOIN v_party_resolved r ON r.party_id = p.id
            WHERE $1 = '' OR p.name ILIKE $1 OR COALESCE(p.party_code, '') ILIKE $1
               OR COALESCE(p.name_kana, '') ILIKE $1
               OR EXISTS (SELECT 1 FROM unnest(p.aliases) al WHERE al ILIKE $1)),
         x AS (
           SELECT r.resolved_id AS party_id,
                  count(*)::int AS total,
                  count(*) FILTER (WHERE COALESCE(a.kind, 'master') IN ('master', 'standalone'))::int AS roots,
                  count(*) FILTER (WHERE a.kind = 'document')::int AS documents,
                  count(*) FILTER (
                    WHERE (a.kind IN ('supplement', 'termination') AND a.parent_id IS NULL)
                       OR (a.parent_id IS NOT NULL AND pr.resolved_id IS DISTINCT FROM r.resolved_id)
                       OR (COALESCE(a.kind, 'master') IN ('master', 'standalone') AND a.domain IS NULL)
                       OR (COALESCE(a.kind, 'master') IN ('master', 'standalone') AND a.parent_id IS NOT NULL)
                  )::int AS issues
             FROM agreements a
             JOIN v_party_resolved r ON r.party_id = a.counterparty_id
             LEFT JOIN agreements pa ON pa.id = a.parent_id
             LEFT JOIN v_party_resolved pr ON pr.party_id = pa.counterparty_id
            GROUP BY r.resolved_id),
         u AS (
           SELECT r.resolved_id AS party_id, count(*)::int AS unlinked
             FROM documents d
             JOIN v_document_display v ON v.document_id = d.id
             JOIN v_party_resolved r ON r.party_id = v.counterparty_id
             LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
             LEFT JOIN document_templates t ON t.id = tv.template_id
            WHERE ${UNLINKED_WHERE}
            GROUP BY r.resolved_id),
         lc AS (
           SELECT r.resolved_id AS party_id, count(*)::int AS loose_conditions
             FROM conditions co
             JOIN v_party_resolved r ON r.party_id = co.counterparty_id
            WHERE ${LOOSE_CONDITION_WHERE}
            GROUP BY r.resolved_id)
         SELECT rp.id AS party_id, rp.name,
                COALESCE(x.total, 0) AS total, COALESCE(x.roots, 0) AS roots,
                COALESCE(x.documents, 0) AS documents, COALESCE(x.issues, 0) AS issues,
                COALESCE(u.unlinked, 0) AS unlinked,
                COALESCE(lc.loose_conditions, 0) AS loose_conditions
           FROM matched m
           JOIN parties rp ON rp.id = m.resolved_id
           LEFT JOIN x ON x.party_id = m.resolved_id
           LEFT JOIN u ON u.party_id = m.resolved_id
           LEFT JOIN lc ON lc.party_id = m.resolved_id
          WHERE ($1 <> '' OR COALESCE(x.total, 0) > 0 OR COALESCE(u.unlinked, 0) > 0
                 OR COALESCE(lc.loose_conditions, 0) > 0)
            AND ($2::boolean = false OR COALESCE(x.issues, 0) > 0 OR COALESCE(u.unlinked, 0) > 0
                 OR COALESCE(lc.loose_conditions, 0) > 0)
          ORDER BY (COALESCE(x.issues, 0) > 0 OR COALESCE(u.unlinked, 0) > 0
                    OR COALESCE(lc.loose_conditions, 0) > 0) DESC, rp.name
          LIMIT 500`,
        [q ? `%${q}%` : "", query.issuesOnly === true]);
      return (r.rows as any[]).map((row) => ({
        id: Number(row.party_id), name: String(row.name ?? ""),
        total: Number(row.total ?? 0), roots: Number(row.roots ?? 0),
        documents: Number(row.documents ?? 0), issues: Number(row.issues ?? 0),
        unlinked: Number(row.unlinked ?? 0),
        looseConditions: Number(row.loose_conditions ?? 0)
      }));
    } catch (error) { throw translate(error); }
  }

  /** 取引先ひとつぶんのマップ。統合元に付いている契約も含める（件数の上限なし）。 */
  async forParty(partyId: number): Promise<PartyMap | null> {
    try {
      const pr = await this.database.query(
        "SELECT resolved_id, resolved_name FROM v_party_resolved WHERE party_id = $1", [partyId]);
      const head = pr.rows[0] as any;
      if (!head) return null;
      const resolvedId = Number(head.resolved_id);
      const r = await this.database.query(
        `${MAP_SELECT}
          WHERE r.resolved_id = $1
          ORDER BY COALESCE(a.parent_id, a.id), a.parent_id NULLS FIRST, a.id`, [resolvedId]);
      const map = buildPartyMap({ id: resolvedId, name: String(head.resolved_name ?? "") },
                                (r.rows as any[]).map(mapAgreementRow));
      const docs = await this.database.query(
        `SELECT d.id, d.document_no, d.status, d.issued_at, v.title, d.manual_inputs->>'title' AS manual_title,
                COALESCE(t.label, d.manual_inputs->>'documentKind', '文書') AS label
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           JOIN v_party_resolved r ON r.party_id = v.counterparty_id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE r.resolved_id = $1 AND ${UNLINKED_WHERE}
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC`, [resolvedId]);
      map.unlinked = (docs.rows as any[]).map((d) => ({
        id: Number(d.id), documentNo: str(d.document_no), label: String(d.label ?? "文書"),
        title: str(d.manual_title) ?? str(d.title), status: String(d.status ?? ""), issuedOn: dateStr(d.issued_at)
      }));
      const conds = await this.database.query(
        `SELECT co.id, co.condition_no, co.name, co.kind, co.direction, co.status, co.term_start,
                w.title AS work_title
           FROM conditions co
           JOIN v_party_resolved r ON r.party_id = co.counterparty_id
           LEFT JOIN works w ON w.id = co.work_id
          WHERE r.resolved_id = $1 AND ${LOOSE_CONDITION_WHERE}
          ORDER BY co.direction, co.id DESC`, [resolvedId]);
      map.looseConditions = (conds.rows as any[]).map((c) => ({
        id: Number(c.id), conditionNo: str(c.condition_no), name: String(c.name ?? ""),
        kind: String(c.kind ?? ""), direction: c.direction === "out" ? "out" : "in",
        status: String(c.status ?? ""), workTitle: str(c.work_title), termStart: dateStr(c.term_start)
      }));
      return map;
    } catch (error) { throw translate(error); }
  }

  /**
   * CSV の一括修正用に書き出す行。全件（取引先を渡せばその取引先の分）。
   * ずれと既定は画面と同じ判定（buildPartyMap）を取引先ごとに通して付ける。
   */
  async exportRows(query: { partyId?: number | null } = {}): Promise<AgreementCsvRow[]> {
    try {
      const resolvedId = query.partyId
        ? int(((await this.database.query(
            "SELECT resolved_id FROM v_party_resolved WHERE party_id = $1", [query.partyId])).rows[0] as any)?.resolved_id)
        : null;
      if (query.partyId && !resolvedId) throw new DomainError("NOT_FOUND", `取引先 ${query.partyId} が見つかりません`);
      const r = await this.database.query(
        `SELECT a.id, a.agreement_no, a.title, a.kind, a.domain, a.direction, a.status, a.parent_id,
                a.executed_on, a.effective_on, a.expires_on, a.auto_renewal, a.counterparty_ref_no,
                a.terminated_on, a.counterparty_id, p.name AS party_name,
                (r.party_id <> r.resolved_id) AS party_merged,
                r.resolved_id, r.resolved_name, rp.party_code AS resolved_code,
                pa.agreement_no AS parent_no, pr.resolved_id AS parent_resolved_id, pa.kind AS parent_kind
           FROM agreements a
           JOIN parties p ON p.id = a.counterparty_id
           JOIN v_party_resolved r ON r.party_id = a.counterparty_id
           JOIN parties rp ON rp.id = r.resolved_id
           LEFT JOIN agreements pa ON pa.id = a.parent_id
           LEFT JOIN v_party_resolved pr ON pr.party_id = pa.counterparty_id
          WHERE ($1::bigint IS NULL OR r.resolved_id = $1)
          ORDER BY r.resolved_name, COALESCE(a.parent_id, a.id), a.parent_id NULLS FIRST, a.id`,
        [resolvedId]);
      const rows = r.rows as any[];
      // 取引先ごとに画面と同じ判定を通す。
      const byParty = new Map<number, any[]>();
      for (const row of rows) {
        const key = Number(row.resolved_id);
        byParty.set(key, [...(byParty.get(key) ?? []), row]);
      }
      const primary = new Set<number>();
      const issues = new Map<number, string[]>();
      for (const [pid, list] of byParty) {
        const map = buildPartyMap({ id: pid, name: String(list[0].resolved_name ?? "") }, list.map(mapAgreementRow));
        for (const root of map.roots) if (root.primary) primary.add(root.id);
        for (const i of map.issues) issues.set(i.agreementId, [...(issues.get(i.agreementId) ?? []), i.message]);
      }
      return rows.map((row) => {
        const a = mapAgreementRow(row);
        return {
          id: a.id, agreementNo: a.agreementNo,
          partyName: String(row.resolved_name ?? ""), partyCode: str(row.resolved_code),
          title: a.title, kind: a.kind, domain: a.domain, direction: a.direction,
          parentNo: str(row.parent_no) ?? (a.parentId ? `#${a.parentId}` : null),
          executedOn: a.executedOn, effectiveOn: dateStr(row.effective_on), expiresOn: dateStr(row.expires_on),
          autoRenewal: row.auto_renewal === true, counterpartyRefNo: str(row.counterparty_ref_no),
          status: a.status, primary: primary.has(a.id), issues: issues.get(a.id) ?? []
        };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 文書フォームで選ぶ値。基本契約（このマップの木の根）・発注書番号・個別契約番号。
   *
   * 文書フォームはこれまで契約一覧を 300 件取ってから画面で取引先に絞っていた
   * （統合元の契約が落ち、補助文書や文書だけも並んでいた）。マップと同じ引き方にする。
   */
  async documentRefs(partyId: number, conditionIds: number[] = []): Promise<DocumentRefs | null> {
    const map = await this.forParty(partyId);
    if (!map) return null;
    try {
      const docs = await this.database.query(
        `SELECT d.id, d.document_no, d.issued_at, v.title,
                t.template_key, COALESCE(t.label, d.manual_inputs->>'documentKind') AS label
           FROM documents d
           JOIN v_document_display v ON v.document_id = d.id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE v.counterparty_id IN (SELECT party_id FROM v_party_resolved WHERE resolved_id = $1)
            AND d.document_no IS NOT NULL
            AND d.status NOT IN ('void', 'superseded', 'draft')
            AND (t.template_key IN ('purchase_order', 'intl_purchase_order')
                 OR t.template_key = ANY($2::text[])
                 OR d.manual_inputs->>'documentKind' = ANY($3::text[]))
          ORDER BY d.issued_at DESC NULLS LAST, d.id DESC
          LIMIT 300`,
        [map.party.id, TERMS_TEMPLATES, TERMS_IMPORT_KINDS]);
      const rows = (docs.rows as any[]).map((d) => ({
        id: Number(d.id), documentNo: String(d.document_no), title: String(d.title ?? ""),
        label: String(d.label ?? "文書"), issuedOn: dateStr(d.issued_at),
        isOrder: d.template_key === "purchase_order" || d.template_key === "intl_purchase_order"
      }));
      const linkedOrders = conditionIds.length ? await this.linkedOrders(conditionIds) : [];
      return {
        party: map.party,
        // 文書の「基本契約」に出せるのは基本契約だけ（単体契約は基本契約なし扱い）。
        masters: map.roots.filter((r) => r.kind === "master").map((r) => ({
          id: r.id, agreementNo: r.agreementNo, title: r.title, kind: r.kind, domain: r.domain,
          direction: r.direction, status: r.status, executedOn: r.executedOn, terminatedOn: r.terminatedOn,
          primary: r.primary, datedTitle: agreementDatedTitle(r.title, r.executedOn) ?? r.title
        })),
        purchaseOrders: rows.filter((d) => d.isOrder).map(({ isOrder: _, ...d }) => d),
        terms: rows.filter((d) => !d.isOrder).map(({ isOrder: _, ...d }) => d),
        linkedOrders
      };
    } catch (error) { throw translate(error); }
  }

  /**
   * 条件につながっている発注書。条件が載っている単体契約（基本契約・補助文書は除く）と、
   * 条件（同じ系列の版を含む）に結びついた発注書の文書（作ったもの・取り込んだもの）。
   */
  private async linkedOrders(conditionIds: number[]): Promise<DocumentRefs["linkedOrders"]> {
    const r = await this.database.query(
      `WITH wanted AS (
         SELECT y.id, y.condition_no, COALESCE(y.series_id, y.id) AS series
           FROM conditions y WHERE y.id = ANY($1::bigint[])
       )
       SELECT 'agreement' AS source, a.id, a.agreement_no AS no, a.title,
              a.executed_on AS issued_on, array_agg(DISTINCT w.condition_no) AS condition_nos
         FROM wanted w
         JOIN conditions c ON c.id = w.id
         JOIN agreements a ON a.id = c.agreement_id
        WHERE COALESCE(a.kind, 'master') IN ('standalone', 'document')
          AND a.agreement_no IS NOT NULL
          AND COALESCE(a.status, '') NOT IN ('void', 'superseded')
        GROUP BY a.id, a.agreement_no, a.title, a.executed_on
       UNION ALL
       SELECT 'document' AS source, d.id, d.document_no AS no, v.title,
              d.issued_at::date AS issued_on, array_agg(DISTINCT w.condition_no) AS condition_nos
         FROM wanted w
         JOIN conditions x ON COALESCE(x.series_id, x.id) = w.series
         JOIN document_conditions dc ON dc.condition_id = x.id
         JOIN documents d ON d.id = dc.document_id
         JOIN v_document_display v ON v.document_id = d.id
         LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
         LEFT JOIN document_templates t ON t.id = tv.template_id
        WHERE d.document_no IS NOT NULL
          AND d.status NOT IN ('void', 'superseded', 'draft')
          AND (t.template_key IN ('purchase_order', 'intl_purchase_order')
               OR COALESCE(d.manual_inputs->>'documentKind', t.label, '') LIKE '%発注%')
        GROUP BY d.id, d.document_no, v.title, d.issued_at
        ORDER BY issued_on DESC NULLS LAST, id DESC`, [conditionIds]);
    const seen = new Set<string>();
    return (r.rows as any[]).flatMap((row) => {
      const no = String(row.no);
      if (seen.has(no)) return [];
      seen.add(no);
      return [{
        id: Number(row.id), documentNo: no, title: String(row.title ?? ""),
        label: row.source === "agreement" ? "単体契約" : "発注書",
        issuedOn: dateStr(row.issued_on),
        source: row.source === "agreement" ? "agreement" as const : "document" as const,
        conditionNos: ((row.condition_nos ?? []) as unknown[]).filter(Boolean).map(String)
      }];
    });
  }

  /**
   * 単体契約を、基本契約の下の個別契約にする（順位を落とす）。
   *
   * 取引の形は（1）基本契約＋個別契約 か（2）単体契約。条件書を先に結び、あとから
   * 基本契約を結んだ相手は、条件書が単体契約のまま残る。ここで基本契約の下に入れ、
   * 載っていた条件明細を基本契約の明細に移す（条件書を決定したときに基本契約の下へ
   * 起こすのと同じ形。agreements/auto.ts）。番号は振り直さない（紙に刷ってある）。
   */
  async demoteToIndividual(id: number, masterId: number, actor: string)
    : Promise<{ conditionsMoved: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `SELECT a.id, a.agreement_no, a.kind, a.direction, a.domain, a.parent_id, r.resolved_id,
                  (SELECT count(*) FROM agreements k WHERE k.parent_id = a.id)::int AS child_count
             FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
            WHERE a.id = $1 FOR UPDATE OF a`, [id]);
        const a = r.rows[0] as any;
        if (!a) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        if ((str(a.kind) ?? "master") !== "standalone") {
          throw new DomainError("VALIDATION", "個別契約にできるのは単体契約だけです");
        }
        if (Number(a.child_count) > 0) {
          throw new DomainError("VALIDATION",
            `この単体契約の下に覚書・解除合意が ${a.child_count} 件あります。先にそちらの親を基本契約に付け替えてください`);
        }
        const mr = await client.query(
          `SELECT a.id, a.agreement_no, a.kind, a.direction, a.domain, a.terminated_on, r.resolved_id
             FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
            WHERE a.id = $1`, [masterId]);
        const m = mr.rows[0] as any;
        if (!m) throw new DomainError("NOT_FOUND", `基本契約 ${masterId} が見つかりません`);
        if ((str(m.kind) ?? "master") !== "master") throw new DomainError("VALIDATION", "親にできるのは基本契約だけです");
        if (Number(m.resolved_id) !== Number(a.resolved_id)) throw new DomainError("VALIDATION", "基本契約と相手先が違います");
        if (m.direction !== a.direction) throw new DomainError("VALIDATION", "基本契約と向き（IN／OUT）が違います");
        if (m.terminated_on) throw new DomainError("VALIDATION", "解除済みの基本契約の下には入れられません");

        await client.query(
          `UPDATE agreements SET kind = 'supplement', parent_id = $2, domain = COALESCE($3, domain), updated_at = now()
            WHERE id = $1`, [id, masterId, str(m.domain)]);
        // 条件明細は基本契約の明細にする（個別契約＝条件書は、その明細を定めた紙）。
        const moved = await client.query(
          "UPDATE conditions SET agreement_id = $2 WHERE agreement_id = $1 RETURNING id", [id, masterId]);
        const conditionIds = (moved.rows as Array<{ id: number }>).map((x) => Number(x.id));
        await recordAudit(client, {
          actor, action: "agreement.demote", targetType: "agreement", targetId: id,
          detail: { agreementNo: str(a.agreement_no), masterId, masterNo: str(m.agreement_no), conditionIds,
                    before: { kind: "standalone", domain: str(a.domain) } }
        });
        return { conditionsMoved: conditionIds.length };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 個別契約を単体契約に戻す（demoteToIndividual の逆）。基本契約に移した条件明細のうち、
   * この契約の文書（条件書）に載っているものを戻す。
   */
  async promoteToStandalone(id: number, actor: string): Promise<{ conditionsMoved: number }> {
    try {
      return await inTransaction(this.database, async (client) => {
        const r = await client.query(
          `SELECT a.id, a.agreement_no, a.kind, a.parent_id, a.domain, p.domain AS parent_domain
             FROM agreements a LEFT JOIN agreements p ON p.id = a.parent_id
            WHERE a.id = $1 FOR UPDATE OF a`, [id]);
        const a = r.rows[0] as any;
        if (!a) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        if (str(a.kind) !== "supplement") throw new DomainError("VALIDATION", "単体契約に戻せるのは個別契約（補助文書）だけです");
        const parentId = int(a.parent_id);
        await client.query(
          `UPDATE agreements SET kind = 'standalone', parent_id = NULL,
                  domain = COALESCE(domain, $2, 'license'), updated_at = now()
            WHERE id = $1`, [id, str(a.parent_domain)]);
        const moved = parentId
          ? await client.query(
              `UPDATE conditions c SET agreement_id = $1
                WHERE c.agreement_id = $2
                  AND EXISTS (SELECT 1 FROM document_conditions dc JOIN documents d ON d.id = dc.document_id
                               WHERE dc.condition_id = c.id AND d.agreement_id = $1
                                 AND d.status NOT IN ('void', 'superseded'))
                RETURNING c.id`, [id, parentId])
          : { rows: [] };
        const conditionIds = (moved.rows as Array<{ id: number }>).map((x) => Number(x.id));
        await recordAudit(client, {
          actor, action: "agreement.promote", targetType: "agreement", targetId: id,
          detail: { agreementNo: str(a.agreement_no), parentId, conditionIds }
        });
        return { conditionsMoved: conditionIds.length };
      });
    } catch (error) { throw translate(error); }
  }

  /**
   * 種類・親・種別・方向・相手先・締結日（CSV からは件名・期間なども）を直す。番号は振り直さない。
   * 変わった項目の名前を返す。何も変わらなければ書かない（監査にも残さない）。
   * dryRun は同じ検証と書き込みを通してから巻き戻す（CSV の試算）。
   */
  async remap(id: number, input: RemapInput, actor: string, options: { dryRun?: boolean } = {})
    : Promise<string[]> {
    try {
      return await inTransaction(this.database, async (client) => {
        const cr = await client.query(
          `SELECT a.id, a.kind, a.domain, a.direction, a.parent_id, a.counterparty_id,
                  a.status, a.executed_on, a.title, a.effective_on, a.expires_on, a.auto_renewal,
                  a.counterparty_ref_no, r.resolved_id,
                  (SELECT count(*) FROM agreements k WHERE k.parent_id = a.id)::int AS child_count
             FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
            WHERE a.id = $1 FOR UPDATE OF a`, [id]);
        const row = cr.rows[0] as any;
        if (!row) throw new DomainError("NOT_FOUND", `契約 ${id} が見つかりません`);
        const current: RemapCurrent = {
          id, kind: (str(row.kind) ?? "master") as AgreementKind,
          domain: (str(row.domain) as AgreementDomain | null) ?? null,
          direction: row.direction === "out" ? "out" : "in",
          parentId: int(row.parent_id), counterpartyId: Number(row.counterparty_id),
          resolvedPartyId: Number(row.resolved_id), childCount: Number(row.child_count ?? 0)
        };

        let targetResolved = current.resolvedPartyId;
        if (input.counterpartyId !== undefined && input.counterpartyId !== current.counterpartyId) {
          const tr = await client.query(
            "SELECT resolved_id FROM v_party_resolved WHERE party_id = $1", [input.counterpartyId]);
          if (!tr.rows[0]) throw new DomainError("NOT_FOUND", `取引先 ${input.counterpartyId} が見つかりません`);
          targetResolved = Number((tr.rows[0] as any).resolved_id);
        }

        const parentId = input.parentId !== undefined ? input.parentId : current.parentId;
        let parent: RemapParent | null = null;
        if (parentId) {
          const pr = await client.query(
            `SELECT a.id, a.kind, r.resolved_id
               FROM agreements a JOIN v_party_resolved r ON r.party_id = a.counterparty_id
              WHERE a.id = $1`, [parentId]);
          const p = pr.rows[0] as any;
          if (p) parent = { id: Number(p.id), kind: (str(p.kind) ?? "master") as AgreementKind,
                            resolvedPartyId: Number(p.resolved_id) };
        }

        const next = planRemap(current, input, parent, targetResolved);
        const executed = input.executedOn !== undefined
          ? executedChange(String(row.status ?? ""), input.executedOn) : null;
        for (const [name, value] of [["有効開始日", input.effectiveOn], ["終了日", input.expiresOn]] as const) {
          if (value && !DATE.test(value)) throw new DomainError("VALIDATION", `${name}は YYYY-MM-DD で入れてください`);
        }
        if (input.title !== undefined && !String(input.title).trim()) {
          throw new DomainError("VALIDATION", "件名を空にはできません");
        }
        const extra = {
          title: input.title !== undefined ? String(input.title).trim() : String(row.title ?? ""),
          effectiveOn: input.effectiveOn !== undefined ? input.effectiveOn : dateStr(row.effective_on),
          expiresOn: input.expiresOn !== undefined ? input.expiresOn : dateStr(row.expires_on),
          autoRenewal: input.autoRenewal !== undefined ? input.autoRenewal : row.auto_renewal === true,
          counterpartyRefNo: input.counterpartyRefNo !== undefined
            ? str(input.counterpartyRefNo) : str(row.counterparty_ref_no)
        };

        const changed = [
          next.kind !== current.kind && "種類",
          next.domain !== current.domain && "種別",
          next.direction !== current.direction && "方向",
          next.parentId !== current.parentId && "親契約",
          next.counterpartyId !== current.counterpartyId && "相手先",
          executed && executed.executedOn !== dateStr(row.executed_on) && "締結日",
          executed && executed.status !== String(row.status ?? "") && "状態",
          extra.title !== String(row.title ?? "") && "件名",
          extra.effectiveOn !== dateStr(row.effective_on) && "有効開始日",
          extra.expiresOn !== dateStr(row.expires_on) && "終了日",
          extra.autoRenewal !== (row.auto_renewal === true) && "自動更新",
          extra.counterpartyRefNo !== str(row.counterparty_ref_no) && "相手方番号"
        ].filter((x): x is string => Boolean(x));
        if (!changed.length) return [];

        await client.query(
          `UPDATE agreements
              SET kind = $2, domain = $3, direction = $4, parent_id = $5, counterparty_id = $6,
                  title = $7, effective_on = $8::date, expires_on = $9::date, auto_renewal = $10,
                  counterparty_ref_no = $11, updated_at = now()
            WHERE id = $1`,
          [id, next.kind, next.domain, next.direction, next.parentId, next.counterpartyId,
           extra.title, extra.effectiveOn, extra.expiresOn, extra.autoRenewal, extra.counterpartyRefNo]);
        if (executed) {
          await client.query(
            `UPDATE agreements
                SET executed_on = $2::date, status = $3,
                    effective_on = COALESCE(effective_on, $2::date), updated_at = now()
              WHERE id = $1`, [id, executed.executedOn, executed.status]);
        }
        await recordAudit(client, {
          actor, action: "agreement.remap", targetType: "agreement", targetId: id,
          detail: {
            before: { kind: current.kind, domain: current.domain, direction: current.direction,
                      parentId: current.parentId, counterpartyId: current.counterpartyId,
                      status: String(row.status ?? ""), executedOn: dateStr(row.executed_on) },
            after: { ...next, ...(executed ?? {}), ...extra },
            changed
          }
        });
        if (options.dryRun) throw new DryRunRollback(changed);
        return changed;
      });
    } catch (error) {
      if (error instanceof DryRunRollback) return error.changed;
      throw translate(error);
    }
  }
}
