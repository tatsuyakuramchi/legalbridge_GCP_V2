import type { MapAgreement, MapIssue, MapNode, MapOrder, PartyMap, UnlinkedDocument } from "../agreements/party-map.js";
import type { MergeCandidate } from "../parties/merge-service.js";
import type { TermTarget } from "../conditions/term-default.js";
import type { NoticeTarget } from "../documents/notice-fill.js";
import type { MergeGroup } from "../royalty/statement-merge.js";

/**
 * 整理する ― 取引先の木を 1 本ずつ直す。
 *
 * 取引先を根に
 *   取引先 → 取引（基本契約 or 独立契約）→ 個別契約（条件書・発注書）→ 条件（作品）
 *          → 実績 → 支払文書 → 支払
 * の木を組み、4 つの印を付ける。
 *   多重（同じものが 2 つ）→ 統合する
 *   未登録（外にあるが台帳に無い）→ 登録する
 *   欠け（親子が繋がっていない）→ 繋ぐ
 *   空（欄が空）→ 埋める
 *
 * 取引の形は 3 つ（docs/v3-tidy.md）。
 *   型 1  基本契約＋個別契約 ＝ 1 取引（kind=master と、その下の supplement・発注書）
 *   型 2  独立契約 ＝ 1 取引（kind=standalone。基本契約の無い発注書も 1 取引）
 *   型 3  複数当事者 ＝ 1 文書・N の関係。共著の受取人は「受取人として」の枝に同じ条件を出し、
 *        多重には数えない。
 *
 * ここは純粋な組み立てだけ。SQL は tidy-service.ts。判定の根拠になる行は全部入力で受け取る。
 */

export type TidyLevel = "party" | "deal" | "order" | "condition" | "events" | "statement" | "payment" | "group";
export type MarkKind = "dup" | "unregistered" | "missing" | "blank";

export const MARK_LABEL: Record<MarkKind, string> = { dup: "多重", unregistered: "未登録", missing: "欠け", blank: "空" };
export const FIX_LABEL: Record<MarkKind, string> = { dup: "統合する", unregistered: "登録する", missing: "繋ぐ", blank: "埋める" };
export const LEVEL_LABEL: Record<TidyLevel, string> = {
  party: "取引先", deal: "取引", order: "個別契約", condition: "条件", events: "実績", statement: "支払文書", payment: "支払", group: ""
};

export interface FixTarget { id: number; code: string | null; title: string }

export type TidyFix =
  /** 取引先の名寄せ。残す方は画面で選ぶ。 */
  | { action: "merge_party"; parties: MergeCandidate["parties"] }
  /** 契約に繋がっていない基本契約書・条件書から契約を立てる。 */
  | { action: "register_document"; documentId: number; role: "master" | "terms" | null }
  /** 契約に載っていない条件を、個別契約・単体契約に載せる。 */
  | { action: "link_condition"; conditionIds: number[]; targets: FixTarget[] }
  /** 親の無い（別の取引先を指す）個別契約を、基本契約の下に繋ぐ。 */
  | { action: "set_parent"; agreementId: number; targets: FixTarget[] }
  /** 契約の列を 1 つ直す（種別を入れる・親を外す）。 */
  | { action: "patch_agreement"; agreementId: number; body: Record<string, unknown>; label: string; choices?: Array<{ value: string; label: string }> }
  /** 契約として登録された発注書を文書に寄せる。 */
  | { action: "order_to_document"; agreementId: number }
  /** 許諾期間を入れる（3 年・3 年ごとの自動更新）。 */
  | { action: "fill_term"; conditionIds: number[]; newTermEnd: string | null; label: string | null }
  /** 通知先を入れて訂正版で出し直す。 */
  | { action: "fill_notice"; documentIds: number[]; fills: NoticeTarget["fills"]; needsStaff: boolean }
  /** 本人分と受取人分の計算書を 1 枚にまとめる。 */
  | { action: "merge_statements"; group: MergeGroup }
  /** 直す画面へ行く（この画面から直せないもの）。 */
  | { action: "open"; kind: "party" | "agreement" | "condition" | "document" | "work"; id: number; label: string };

export interface TidyMark {
  /** 木の中で一意。画面で「今押している印」を覚える。 */
  id: string;
  kind: MarkKind;
  message: string;
  fix: TidyFix | null;
}

export interface TidyNode {
  key: string;
  level: TidyLevel;
  id: number | null;
  code: string | null;
  title: string;
  detail: string | null;
  /** この節と、その下に印が 1 つも無い。 */
  ok: boolean;
  marks: TidyMark[];
  children: TidyNode[];
  /** 型 3：他の取引先の木にも同じものがある（受取人として見ている）。 */
  shared?: boolean;
  entity?: { kind: "party" | "agreement" | "condition" | "document" | "work" | "payment"; id: number };
}

export interface TidyTree {
  party: { id: number; name: string; kind: string; email: string | null };
  /** 統合元を含む、この取引先として扱う取引先 id。 */
  members: number[];
  roots: TidyNode[];
  counts: Record<MarkKind, number>;
  total: number;
}

export interface TidyConditionRow {
  id: number; conditionNo: string | null; name: string; kind: string; direction: "in" | "out"; status: string;
  usageType: string | null;
  /** 多重の判定に使う値段の形（同じ作品・同じ種類でも、率や額が違えば別の条件）。 */
  pricingModel: string | null; ratePpm: number | null; flatAmount: number | null;
  workId: number | null; workTitle: string | null;
  agreementId: number | null;
  termStart: string | null; termEnd: string | null; autoRenew: boolean;
  /** 発注書・条件書（文書）に載っているときの文書 id。 */
  holderDocumentId: number | null;
  /** 共著の取り分の数（受取人の数）。 */
  shares: number;
  /** 型 3：この取引先は相手方ではなく受取人（取り分）としてこの条件に関わる。 */
  shared: boolean;
  /** shared のとき、相手方（代表）の名前。 */
  counterpartyName: string | null;
}

export interface TidyEventStat {
  conditionId: number; total: number; first: string | null; last: string | null;
  /** 支払に割り当たっていない実績の数。 */
  unallocated: number;
  /** 割り当て済みの実績より前の日付なのに割り当たっていない実績の数（取り残し）。 */
  gap: number;
}

export interface TidyStatementRow {
  documentId: number; documentNo: string | null; status: string; issuedOn: string | null;
  period: string | null; conditionId: number; payeePartyId: number | null; netAmount: number;
}

export interface TidyPaymentRow {
  id: number; paymentNo: string | null; status: string; dueOn: string | null; paidOn: string | null;
  amount: number; currency: string; conditionIds: number[];
}

/** 通知先を埋める文書が、どの契約・条件に付いているか。 */
export interface TidyDocumentHolder { documentId: number; agreementId: number | null; conditionIds: number[] }

export interface TidyInput {
  party: TidyTree["party"];
  members: number[];
  map: PartyMap;
  conditions: TidyConditionRow[];
  events: TidyEventStat[];
  statements: TidyStatementRow[];
  payments: TidyPaymentRow[];
  mergeCandidates: MergeCandidate[];
  termTargets: TermTarget[];
  noticeTargets: NoticeTarget[];
  noticeHolders: TidyDocumentHolder[];
  statementGroups: MergeGroup[];
}

const KIND_LABEL: Record<string, string> = {
  master: "基本契約", standalone: "独立契約", supplement: "個別契約", termination: "解除合意", document: "文書"
};
const STATUS_LABEL: Record<string, string> = {
  draft: "下書き", negotiating: "交渉中", executed: "締結済", expired: "満了", terminated: "解除",
  active: "有効", scheduled: "予定", superseded: "差し替え済", void: "取消", issued: "決定済",
  planned: "予定", approved: "承認済", paid: "支払済", canceled: "取消"
};
const label = (s: string | null | undefined) => (s ? STATUS_LABEL[s] ?? s : "");

const yen = (n: number, currency = "JPY") => `${currency === "JPY" ? "¥" : `${currency} `}${Math.round(n).toLocaleString("ja-JP")}`;
const ym = (d: string | null) => (d ? `${d.slice(0, 4)}/${Number(d.slice(5, 7))}` : "");

function node(level: TidyLevel, key: string, title: string, over: Partial<TidyNode> = {}): TidyNode {
  return { key, level, id: null, code: null, title, detail: null, ok: true, marks: [], children: [], ...over };
}

/** 契約 → 木の節。印は issues から（同じ契約の分だけ）。 */
function agreementNode(a: MapAgreement, level: TidyLevel, issues: MapIssue[], map: PartyMap): TidyNode {
  const dates = [a.executedOn ? `締結 ${a.executedOn}` : null, a.terminatedOn ? `解除 ${a.terminatedOn}` : null].filter(Boolean).join("・");
  const n = node(level, `a${a.id}`, a.title || a.agreementNo || `#${a.id}`, {
    id: a.id, code: a.agreementNo,
    detail: [KIND_LABEL[a.kind] ?? a.kind, label(a.status), dates].filter(Boolean).join("・"),
    entity: { kind: "agreement", id: a.id }
  });
  for (const issue of issues.filter((x) => x.agreementId === a.id)) n.marks.push(issueMark(issue, a, map));
  return n;
}

const masters = (map: PartyMap): FixTarget[] =>
  map.roots.filter((r) => r.kind === "master" && r.status !== "terminated")
    .map((r) => ({ id: r.id, code: r.agreementNo, title: r.title }));

/** 条件を載せられる契約（個別契約・単体契約）。基本契約は条件を持たない。 */
const conditionTargets = (map: PartyMap): FixTarget[] =>
  [...map.roots.flatMap((r) => [r as MapAgreement, ...r.children]), ...map.loose]
    .filter((a) => (a.kind === "standalone" || a.kind === "supplement") && a.status !== "terminated")
    .map((a) => ({ id: a.id, code: a.agreementNo, title: a.title }));

function issueMark(issue: MapIssue, a: MapAgreement, map: PartyMap): TidyMark {
  const id = `issue:${issue.code}:${issue.agreementId}`;
  switch (issue.code) {
    case "orphan":
    case "parent_party_mismatch":
    case "parent_not_master":
      return { id, kind: "missing", message: issue.message, fix: { action: "set_parent", agreementId: a.id, targets: masters(map) } };
    case "master_with_parent":
    case "standalone_with_master":
      return { id, kind: "missing", message: issue.message,
               fix: { action: "patch_agreement", agreementId: a.id, body: { parentId: null }, label: "親を外す" } };
    case "no_domain":
      return { id, kind: "blank", message: issue.message,
               fix: { action: "patch_agreement", agreementId: a.id, body: {}, label: "種別を入れる",
                      choices: [{ value: "license", label: "ライセンス" }, { value: "service", label: "業務委託" }] } };
    case "duplicate_master":
      return { id, kind: "dup", message: issue.message, fix: { action: "open", kind: "agreement", id: a.id, label: "契約を開いて片方を解除・差し替えにする" } };
    case "order_as_agreement":
      return { id, kind: "unregistered", message: issue.message, fix: { action: "order_to_document", agreementId: a.id } };
    case "master_holds_conditions":
      return { id, kind: "missing", message: issue.message, fix: null };
    default:
      return { id, kind: "missing", message: issue.message, fix: null };
  }
}

/** 同じ作品・同じ種類・同じ用途・同じ向き・同じ値段（率・額）で、期間の重なる有効な条件が 2 本以上。 */
function duplicateConditions(conds: TidyConditionRow[]): Map<number, TidyConditionRow[]> {
  const out = new Map<number, TidyConditionRow[]>();
  const live = conds.filter((c) => c.status === "active" && !c.shared);
  const by = new Map<string, TidyConditionRow[]>();
  for (const c of live) {
    const k = `${c.workId ?? "-"}|${c.kind}|${c.usageType ?? ""}|${c.direction}|${c.pricingModel ?? ""}|${c.ratePpm ?? ""}|${c.flatAmount ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), c]);
  }
  const overlaps = (a: TidyConditionRow, b: TidyConditionRow) => {
    const as = a.termStart ?? "0000", bs = b.termStart ?? "0000";
    const ae = a.autoRenew || !a.termEnd ? "9999" : a.termEnd;
    const be = b.autoRenew || !b.termEnd ? "9999" : b.termEnd;
    return as <= be && bs <= ae;
  };
  for (const group of by.values()) {
    if (group.length < 2) continue;
    for (const c of group) {
      const twins = group.filter((o) => o.id !== c.id && overlaps(c, o));
      if (twins.length) out.set(c.id, twins);
    }
  }
  return out;
}

export function buildTidy(input: TidyInput): TidyTree {
  const { map, party, members } = input;
  const memberSet = new Set(members);
  const issues = map.issues;
  const conds = input.conditions;
  const condById = new Map(conds.map((c) => [c.id, c]));
  const events = new Map(input.events.map((e) => [e.conditionId, e]));
  const stmtsByCond = new Map<number, TidyStatementRow[]>();
  for (const s of input.statements) stmtsByCond.set(s.conditionId, [...(stmtsByCond.get(s.conditionId) ?? []), s]);
  const paysByCond = new Map<number, TidyPaymentRow[]>();
  for (const p of input.payments) for (const cid of p.conditionIds) paysByCond.set(cid, [...(paysByCond.get(cid) ?? []), p]);
  const termByCond = new Map(input.termTargets.map((t) => [t.conditionId, t]));
  const groupByDoc = new Map<number, MergeGroup>();
  for (const g of input.statementGroups) for (const d of g.documents) groupByDoc.set(d.id, g);
  const dups = duplicateConditions(conds);
  const placed = new Set<number>();

  const statementNode = (s: TidyStatementRow, c: TidyConditionRow): TidyNode => {
    const pays = (paysByCond.get(c.id) ?? []).filter((p) => p.status !== "canceled");
    const n = node("statement", `d${s.documentId}`, s.documentNo ?? `#${s.documentId}`, {
      id: s.documentId, code: s.documentNo,
      detail: [s.period, label(s.status), yen(s.netAmount)].filter(Boolean).join("・"),
      entity: { kind: "document", id: s.documentId }
    });
    const g = groupByDoc.get(s.documentId);
    if (g) {
      n.marks.push({ id: `stmt-merge:${g.key}`, kind: "dup",
        message: `本人分と受取人分が別の計算書（${g.documents.map((d) => d.documentNo ?? `#${d.id}`).join("・")}）になっています`,
        fix: { action: "merge_statements", group: g } });
    }
    if (s.status === "issued" && !pays.length) {
      n.marks.push({ id: `stmt-nopay:${s.documentId}`, kind: "missing", message: "決定済みなのに支払がありません",
        fix: { action: "open", kind: "document", id: s.documentId, label: "計算書を開いて支払を作る" } });
    }
    return n;
  };

  const conditionNode = (c: TidyConditionRow): TidyNode => {
    placed.add(c.id);
    const term = c.termStart || c.termEnd
      ? `${c.termStart ?? "?"}〜${c.termEnd ?? ""}${c.autoRenew ? "（自動更新）" : ""}` : null;
    const n = node("condition", `c${c.id}${c.shared ? "s" : ""}`, c.name || c.conditionNo || `#${c.id}`, {
      id: c.id, code: c.conditionNo,
      detail: [c.workTitle, label(c.status), term, c.shares ? `共著 ${c.shares} 人` : null].filter(Boolean).join("・"),
      entity: { kind: "condition", id: c.id }, ...(c.shared ? { shared: true } : {})
    });
    if (c.shared) n.detail = [`相手方 ${c.counterpartyName ?? "?"}`, n.detail].filter(Boolean).join("・");
    const t = termByCond.get(c.id);
    if (t && !c.shared) {
      n.marks.push({ id: `term:${c.id}`, kind: "blank",
        message: t.skip ? `許諾期間の終了日が無い（${t.skip}）` : `許諾期間の終了日が無い → ${t.newTermEnd}（3 年・自動更新）`,
        fix: t.skip ? null : { action: "fill_term", conditionIds: [c.id], newTermEnd: t.newTermEnd, label: t.label } });
    }
    const twins = dups.get(c.id);
    if (twins) {
      n.marks.push({ id: `cond-dup:${c.id}`, kind: "dup",
        message: `同じ作品・同じ種類で期間の重なる条件が他にもあります（${twins.map((x) => x.conditionNo ?? `#${x.id}`).join("・")}）`,
        fix: { action: "open", kind: "condition", id: c.id, label: "条件を開いて片方を差し替え済みにする" } });
    }
    const ev = events.get(c.id);
    if (ev && ev.total > 0) {
      const e = node("events", `e${c.id}`, `${ev.total} 件`, {
        detail: ev.first ? `${ym(ev.first)}〜${ym(ev.last)}` : null, entity: { kind: "condition", id: c.id }
      });
      if (ev.gap > 0) {
        e.marks.push({ id: `events-gap:${c.id}`, kind: "missing",
          message: `${ev.gap} 件が、あとの実績は支払に割り当たっているのに割り当たっていません`,
          fix: { action: "open", kind: "condition", id: c.id, label: "条件を開いて支払に割り当てる" } });
      }
      n.children.push(e);
    }
    const stmts = (stmtsByCond.get(c.id) ?? []).filter((s) => c.shared
      ? s.payeePartyId != null && memberSet.has(s.payeePartyId)
      : s.payeePartyId == null || memberSet.has(s.payeePartyId));
    for (const s of stmts) n.children.push(statementNode(s, c));
    const pays = (paysByCond.get(c.id) ?? []).filter((p) => p.status !== "canceled");
    for (const p of pays) {
      n.children.push(node("payment", `p${p.id}`, p.paymentNo ?? `#${p.id}`, {
        id: p.id, code: p.paymentNo,
        detail: [label(p.status), p.paidOn ? `支払 ${p.paidOn}` : p.dueOn ? `期日 ${p.dueOn}` : null, yen(p.amount, p.currency)].filter(Boolean).join("・"),
        entity: { kind: "payment", id: p.id }
      }));
    }
    return n;
  };

  const orderNode = (o: MapOrder): TidyNode => {
    const n = node("order", `o${o.id}`, o.title || o.documentNo || `#${o.id}`, {
      id: o.id, code: o.documentNo,
      detail: [o.imported ? "発注書（取込）" : "発注書", label(o.status), o.issuedOn ? `発行 ${o.issuedOn}` : null].filter(Boolean).join("・"),
      entity: { kind: "document", id: o.id }
    });
    for (const oc of o.conditions) {
      const c = condById.get(oc.id);
      if (c) n.children.push(conditionNode(c));
    }
    return n;
  };

  const condsOf = (agreementId: number) => conds.filter((c) => !c.shared && c.agreementId === agreementId && !c.holderDocumentId);

  const dealNode = (root: MapNode): TidyNode => {
    const n = agreementNode(root, "deal", issues, map);
    if (root.primary) n.detail = [n.detail, "既定"].filter(Boolean).join("・");
    for (const child of root.children) {
      const cn = agreementNode(child, "order", issues, map);
      for (const c of condsOf(child.id)) cn.children.push(conditionNode(c));
      n.children.push(cn);
    }
    for (const o of (map.orders ?? []).filter((x) => x.masterId === root.id)) n.children.push(orderNode(o));
    // 単体契約は条件を直接持つ。基本契約に直接載っている条件もここに出す（印は issues に付いている）。
    for (const c of condsOf(root.id)) {
      const cn = conditionNode(c);
      if (root.kind === "master") {
        cn.marks.push({ id: `cond-on-master:${c.id}`, kind: "missing",
          message: "基本契約に直接載っています。個別契約（条件書・発注書）に載せてください",
          fix: { action: "link_condition", conditionIds: [c.id], targets: conditionTargets(map) } });
      }
      n.children.push(cn);
    }
    return n;
  };

  const roots: TidyNode[] = [];

  // 取引先
  const partyNode = node("party", `party${party.id}`, party.name, {
    id: party.id, detail: [party.kind === "corporate" ? "法人" : "個人", party.email].filter(Boolean).join("・"),
    entity: { kind: "party", id: party.id }
  });
  for (const g of input.mergeCandidates) {
    if (!g.parties.some((p) => memberSet.has(p.id))) continue;
    const others = g.parties.filter((p) => !memberSet.has(p.id));
    if (!others.length) continue;
    partyNode.marks.push({ id: `party-dup:${g.keyName}`, kind: "dup",
      message: `同じ名前・カナ・法人番号の取引先が ${g.parties.length} 件（${g.parties.map((p) => `${p.name}（#${p.id}）`).join("・")}）`,
      fix: { action: "merge_party", parties: g.parties } });
  }
  roots.push(partyNode);

  // 取引：基本契約・独立契約（型 1・型 2）
  for (const root of map.roots) roots.push(dealNode(root));
  // 基本契約の無い発注書も 1 取引（型 2）
  for (const o of (map.orders ?? []).filter((x) => x.masterId === null)) {
    const n = orderNode(o);
    n.level = "deal"; n.key = `od${o.id}`;
    n.detail = ["独立契約（発注書の約款）", n.detail].filter(Boolean).join("・");
    roots.push(n);
  }

  // 木に入らない個別契約（親なし・親の相手先違い）
  if (map.loose.length) {
    const g = node("group", "g-loose", "親の無い個別契約・解除合意");
    for (const a of map.loose) {
      const n = agreementNode(a, "order", issues, map);
      if (!n.marks.length) {
        n.marks.push({ id: `loose:${a.id}`, kind: "missing", message: "基本契約の下に繋がっていません",
          fix: { action: "set_parent", agreementId: a.id, targets: masters(map) } });
      }
      for (const c of condsOf(a.id)) n.children.push(conditionNode(c));
      g.children.push(n);
    }
    roots.push(g);
  }

  // 契約に繋がっていない文書（未登録）
  if (map.unlinked.length) {
    const g = node("group", "g-unlinked", "契約に繋がっていない文書");
    for (const d of map.unlinked) g.children.push(unlinkedNode(d));
    roots.push(g);
  }

  // 契約に載っていない条件（欠け）。基本契約に直接載っている分は上で出した。
  const strays = conds.filter((c) => !c.shared && !placed.has(c.id));
  if (strays.length) {
    const g = node("group", "g-stray", "契約に載っていない条件");
    const targets = conditionTargets(map);
    for (const c of strays) {
      const n = conditionNode(c);
      n.marks.unshift({ id: `stray:${c.id}`, kind: "missing",
        message: c.agreementId ? "別の取引先の契約を指しています" : "どの契約にも載っていません",
        fix: { action: "link_condition", conditionIds: [c.id], targets } });
      g.children.push(n);
    }
    roots.push(g);
  }

  // 型 3：受取人として（共著の取り分）。相手方の木にある同じ条件。多重には数えない。
  const shared = conds.filter((c) => c.shared);
  if (shared.length) {
    const g = node("group", "g-shared", "受取人として（共著の取り分）", { shared: true,
      detail: "相手方（代表）の木にある条件。ここでは自分宛ての計算書・支払だけを見る" });
    for (const c of shared) g.children.push(conditionNode(c));
    roots.push(g);
  }

  // 通知先の空いた契約書：その文書が付いている契約・条件の節に印を付ける。
  for (const t of input.noticeTargets) {
    const h = input.noticeHolders.find((x) => x.documentId === t.documentId);
    const fix: TidyFix | null = t.skip && !t.fills.length ? null
      : { action: "fill_notice", documentIds: [t.documentId], fills: t.fills, needsStaff: t.skip?.includes("担当者") ?? false };
    const mark: TidyMark = { id: `notice:${t.documentId}`, kind: "blank",
      message: `${t.documentNo ?? `#${t.documentId}`}（${t.kind === "master" ? "基本契約書" : "条件書"}）の通知先が空${t.skip ? `（${t.skip}）` : ""}`,
      fix };
    const target = findNode(roots, (n) =>
      (h?.agreementId != null && n.level !== "condition" && n.id === h.agreementId && (n.level === "deal" || n.level === "order"))
      || (h?.conditionIds.length ? n.level === "condition" && n.id != null && h.conditionIds.includes(n.id) && !n.shared : false));
    (target ?? partyNode).marks.push(mark);
  }

  const counts: Record<MarkKind, number> = { dup: 0, unregistered: 0, missing: 0, blank: 0 };
  const seen = new Set<string>();
  const settle = (n: TidyNode): boolean => {
    let ok = n.marks.length === 0;
    for (const m of n.marks) if (!seen.has(m.id)) { seen.add(m.id); counts[m.kind] += 1; }
    for (const ch of n.children) if (!settle(ch)) ok = false;
    n.ok = ok;
    return ok;
  };
  for (const r of roots) settle(r);
  const total = counts.dup + counts.unregistered + counts.missing + counts.blank;
  return { party, members, roots, counts, total };
}

function unlinkedNode(d: UnlinkedDocument): TidyNode {
  const n = node("order", `u${d.id}`, d.title || d.documentNo || `#${d.id}`, {
    id: d.id, code: d.documentNo,
    detail: [d.label, label(d.status), d.issuedOn ? `発行 ${d.issuedOn}` : null, d.conditionCount ? `条件 ${d.conditionCount}` : null].filter(Boolean).join("・"),
    entity: { kind: "document", id: d.id }
  });
  n.marks.push({ id: `unlinked:${d.id}`, kind: "unregistered",
    message: d.role ? "台帳（契約）に無い。番号を変えずに契約を立てる" : "契約に繋がっていない（NDA・覚書など）。契約の画面で繋ぐ",
    fix: d.role ? { action: "register_document", documentId: d.id, role: d.role }
                : { action: "open", kind: "document", id: d.id, label: "文書を開いて契約に繋ぐ" } });
  return n;
}

function findNode(roots: TidyNode[], pred: (n: TidyNode) => boolean): TidyNode | null {
  for (const r of roots) {
    if (pred(r)) return r;
    const hit = findNode(r.children, pred);
    if (hit) return hit;
  }
  return null;
}

/** 印の付いた節だけ残す（「直すところだけ」）。印の無い枝は畳んで 1 行にする。 */
export function marksOnly(nodes: TidyNode[]): TidyNode[] {
  return nodes.filter((n) => !n.ok).map((n) => ({ ...n, children: marksOnly(n.children) }));
}

/** 印を木の順に並べる（右の欄の「次へ」）。 */
export function allMarks(nodes: TidyNode[]): Array<{ node: TidyNode; mark: TidyMark }> {
  const out: Array<{ node: TidyNode; mark: TidyMark }> = [];
  const seen = new Set<string>();
  const walk = (n: TidyNode) => {
    for (const m of n.marks) if (!seen.has(m.id)) { seen.add(m.id); out.push({ node: n, mark: m }); }
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
