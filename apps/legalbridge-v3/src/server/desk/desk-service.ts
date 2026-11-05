import type { Queryable } from "../core/db.js";
import { dateStr, int, str } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * ホームの「今日やること」と作業台のツリー（docs/desk-home.md）。
 *
 * 軽さが目的。ホームを開いたときに読むのは「今日やること」だけで、作業台は開いたときに読む。
 *   - 今日やることは、受付箱（新規・更新あり）・その人のデイリータスク・14 日以内の期限だけを、
 *     並べて投げずに 1 本ずつ順に読み、結果を 1 分覚える（同時に来た要求は 1 回の計算に相乗り）。
 *     旧ホームの盤面（10 本の集計）は呼ばない。
 *   - ツリーは一段目だけを返し、取引先の下（契約）は開いたときに別に読む。一段目は 1 分覚える。
 */

export type TodayKind = "intake" | "task" | "deadline";
export type TodayWhen = "over" | "today" | "week" | "later" | "none";
export type DeskRoot = "party" | "matter" | "work";

export interface TodayItem {
  key: string;
  kind: TodayKind;
  /** 期限の種類（kind = deadline のとき）。matter / agreement / payment / schedule。 */
  source: string | null;
  refId: number;
  refNo: string | null;
  title: string;
  sub: string | null;
  dueOn: string | null;
  when: TodayWhen;
  /** 受付箱で「更新あり」。 */
  updated: boolean;
  /** 作業台で開く先。分かるときだけ。 */
  desk: { root: DeskRoot; id: number } | null;
}

export interface Today {
  items: TodayItem[];
  counts: { over: number; today: number; week: number; total: number };
  /** 集計した時刻（覚えていた結果なら、そのときの時刻）。 */
  at: string;
}

/** 読む道具。テストで差し替えられるように、要るメソッドと列だけ受け取る。 */
export interface TodayTools {
  intake: {
    list(tab: "new" | "updated"): Promise<Array<{
      id: number; requestNo: string | null; title: string; counterpartyName: string | null; counterpartyId: number | null;
      requesterName: string | null; dueOn: string | null; createdAt: string; matterId: number | null; hasUnseenUpdate: boolean;
    }>>;
  };
  tasks: {
    list(tab: "open", assignee: number | null): Promise<Array<{
      id: number; title: string; dueOn: string | null; purposeLabel: string;
      request: { requestNo: string | null; counterpartyName: string | null };
    }>>;
  };
  deadlines: {
    deadlines(days: number): Promise<Array<{
      source: string; refId: number; refNo: string | null; title: string; dueOn: string; status: string; overdue: boolean;
    }>>;
  };
}

export interface DeskNode {
  key: string;
  kind: "party" | "agreement" | "loose" | "matter" | "work";
  id: number | null;
  label: string;
  sub: string | null;
  /** 生きている条件の本数。 */
  count: number;
  /** 下を開けるか（取引先だけ。契約の一覧を別に読む）。 */
  expandable: boolean;
  /** 契約の行：その契約と補助文書の ID（工程表の行を契約で絞るのに使う）。 */
  agreementIds?: number[];
}

/** 覚えておく時間。 */
const CACHE_MS = 60_000;
/** 今日やることで返す上限。画面は 5 件を出し、「すべて見る」で残りを出す。 */
const TODAY_LIMIT = 50;
/** ツリーの一段目の上限。探すときは検索語で絞る。 */
const ROOT_LIMIT = 100;
/** 生きている条件。 */
const LIVE = `c.status NOT IN ('void', 'superseded')`;
const WHEN_ORDER: Record<TodayWhen, number> = { over: 0, today: 1, week: 2, later: 3, none: 4 };
const KIND_ORDER: Record<TodayKind, number> = { intake: 0, task: 1, deadline: 2 };

/** 東京の日付（YYYY-MM-DD）。 */
export const tokyoDate = (d: Date): string =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);

const addDays = (ymd: string, days: number): string => {
  const t = new Date(`${ymd}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};

export const whenOf = (dueOn: string | null, today: string): TodayWhen => {
  if (!dueOn) return "none";
  if (dueOn < today) return "over";
  if (dueOn === today) return "today";
  if (dueOn <= addDays(today, 7)) return "week";
  return "later";
};

/** ILIKE の検索語。% と _ はそのままの字として扱う。 */
const likeOf = (q: string | null | undefined): string | null => {
  const t = (q ?? "").trim();
  return t ? `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
};

const DEADLINE_SUB: Record<string, string> = {
  matter: "案件の期日", agreement: "契約の満了", payment: "支払の期日", schedule: "予定の期日"
};

class Memo<T> {
  private cache = new Map<string, { at: number; value: T }>();
  private inflight = new Map<string, Promise<T>>();
  constructor(private readonly ms: number, private readonly max = 100) {}
  get(key: string, run: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ms) return Promise.resolve(hit.value);
    const going = this.inflight.get(key);
    if (going) return going;
    const p = run()
      .then((value) => {
        if (this.cache.size >= this.max) this.cache.clear();
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
}

export class DeskService {
  constructor(
    private readonly database: Queryable,
    private readonly tools: TodayTools,
    private readonly now: () => Date = () => new Date()
  ) {}

  private readonly todayMemo = new Memo<Today>(CACHE_MS);
  private readonly rootMemo = new Memo<DeskNode[]>(CACHE_MS);

  /** 今日やること。assignee はデイリータスクの担当（null は全員）。 */
  today(assignee: number | null): Promise<Today> {
    return this.todayMemo.get(String(assignee ?? "all"), () => this.computeToday(assignee));
  }

  private async computeToday(assignee: number | null): Promise<Today> {
    const today = tokyoDate(this.now());
    const safe = async <T,>(run: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await run(); } catch { return fallback; }
    };
    // 並べて投げない（接続プールを独り占めしない）。1 本ずつ順に読む。
    const fresh = await safe(() => this.tools.intake.list("new"), []);
    const updated = await safe(() => this.tools.intake.list("updated"), []);
    const tasks = await safe(() => this.tools.tasks.list("open", assignee), []);
    const deadlines = await safe(() => this.tools.deadlines.deadlines(14), []);

    const items: TodayItem[] = [];
    const seen = new Set<number>();
    for (const r of [...updated, ...fresh]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const who = [r.counterpartyName, r.requesterName ? `依頼者 ${r.requesterName}` : null].filter(Boolean).join(" ・ ");
      items.push({
        key: `intake:${r.id}`, kind: "intake", source: null, refId: r.id, refNo: r.requestNo,
        title: r.title, sub: who || null, dueOn: r.dueOn,
        // 受付箱は期日が無くても今日の仕事（振り分けるまで止まる）。
        when: r.dueOn ? whenOf(r.dueOn, today) : "today",
        updated: r.hasUnseenUpdate,
        desk: r.matterId ? { root: "matter", id: r.matterId } : r.counterpartyId ? { root: "party", id: r.counterpartyId } : null
      });
    }
    for (const t of tasks) {
      const sub = [t.purposeLabel, t.request.counterpartyName, t.request.requestNo].filter(Boolean).join(" ・ ");
      items.push({
        key: `task:${t.id}`, kind: "task", source: null, refId: t.id, refNo: t.request.requestNo,
        title: t.title, sub: sub || null, dueOn: t.dueOn, when: whenOf(t.dueOn, today), updated: false, desk: null
      });
    }
    for (const d of deadlines) {
      // 作業（tasks）はデイリータスクとして上で出している。
      if (d.source === "task") continue;
      items.push({
        key: `deadline:${d.source}:${d.refId}`, kind: "deadline", source: d.source, refId: d.refId, refNo: d.refNo,
        title: d.title, sub: [DEADLINE_SUB[d.source] ?? null, d.refNo].filter(Boolean).join(" ・ ") || null,
        dueOn: d.dueOn || null, when: d.overdue ? "over" : whenOf(d.dueOn || null, today), updated: false,
        desk: d.source === "matter" ? { root: "matter", id: d.refId } : null
      });
    }
    items.sort((a, b) =>
      WHEN_ORDER[a.when] - WHEN_ORDER[b.when]
      || (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31")
      || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
      || a.key.localeCompare(b.key));
    const counts = {
      over: items.filter((x) => x.when === "over").length,
      today: items.filter((x) => x.when === "today").length,
      week: items.filter((x) => x.when === "week").length,
      total: items.length
    };
    return { items: items.slice(0, TODAY_LIMIT), counts, at: this.now().toISOString() };
  }

  /** ツリーの一段目。検索語が無いときだけ 1 分覚える。 */
  roots(root: DeskRoot, q: string | null): Promise<DeskNode[]> {
    const like = likeOf(q);
    if (like) return this.computeRoots(root, like);
    return this.rootMemo.get(root, () => this.computeRoots(root, null));
  }

  private async computeRoots(root: DeskRoot, like: string | null): Promise<DeskNode[]> {
    try {
      if (root === "party") {
        const r = await this.database.query(
          `SELECT p.id, p.name, p.party_code, count(c.id)::int AS n
             FROM conditions c JOIN parties p ON p.id = c.counterparty_id
            WHERE ${LIVE}
              AND ($1::text IS NULL OR p.name ILIKE $1 OR p.party_code ILIKE $1)
            GROUP BY p.id, p.name, p.party_code
            ORDER BY max(c.updated_at) DESC, p.id DESC
            LIMIT $2`, [like, ROOT_LIMIT]);
        return (r.rows as any[]).map((x) => ({
          key: `party:${x.id}`, kind: "party" as const, id: Number(x.id), label: String(x.name ?? ""),
          sub: str(x.party_code), count: Number(x.n ?? 0), expandable: true
        }));
      }
      if (root === "matter") {
        const r = await this.database.query(
          `SELECT m.id, m.matter_no, m.title, m.due_on,
                  (SELECT count(*)::int FROM matter_links ml
                     JOIN conditions c ON ml.target_type = 'condition' AND c.id::text = ml.target_ref
                    WHERE ml.matter_id = m.id AND ${LIVE}) AS n
             FROM matters m
            WHERE m.status NOT IN ('done', 'canceled')
              AND ($1::text IS NULL OR m.title ILIKE $1 OR m.matter_no ILIKE $1)
            ORDER BY m.due_on NULLS LAST, m.id DESC
            LIMIT $2`, [like, ROOT_LIMIT]);
        return (r.rows as any[]).map((x) => {
          const due = dateStr(x.due_on);
          return {
            key: `matter:${x.id}`, kind: "matter" as const, id: Number(x.id), label: String(x.title ?? ""),
            sub: [str(x.matter_no), due ? `期日 ${due}` : null].filter(Boolean).join(" ・ ") || null,
            count: Number(x.n ?? 0), expandable: false
          };
        });
      }
      const r = await this.database.query(
        `SELECT w.id, w.work_code, w.title, count(c.id)::int AS n,
                count(c.id) FILTER (WHERE c.kind = 'license')::int AS licenses
           FROM conditions c JOIN works w ON w.id = c.work_id
          WHERE ${LIVE}
            AND ($1::text IS NULL OR w.title ILIKE $1 OR w.work_code ILIKE $1 OR w.title_kana ILIKE $1)
          GROUP BY w.id, w.work_code, w.title
          ORDER BY max(c.updated_at) DESC, w.id DESC
          LIMIT $2`, [like, ROOT_LIMIT]);
      return (r.rows as any[]).map((x) => ({
        key: `work:${x.id}`, kind: "work" as const, id: Number(x.id), label: String(x.title ?? ""),
        sub: [str(x.work_code), Number(x.licenses ?? 0) ? `利用許諾 ${Number(x.licenses)} 本` : null].filter(Boolean).join(" ・ ") || null,
        count: Number(x.n ?? 0), expandable: false
      }));
    } catch (error) { throw translate(error); }
  }

  /**
   * 取引先の下：基本契約・単体契約（補助文書はその親に数える）と、どの契約にも紐づかない条件。
   * 開いたときにだけ読む。
   */
  async partyChildren(partyId: number): Promise<DeskNode[]> {
    try {
      const r = await this.database.query(
        `WITH tops AS (
           SELECT a.id, a.agreement_no, a.title, COALESCE(a.kind, 'master') AS kind, a.status, a.direction, a.expires_on
             FROM agreements a
            WHERE a.counterparty_id = $1 AND COALESCE(a.kind, 'master') IN ('master', 'standalone')
            ORDER BY (a.status = 'executed') DESC, a.id DESC
            LIMIT 100
         )
         SELECT t.*, fam.ids,
                (SELECT count(*)::int FROM conditions c WHERE c.agreement_id = ANY(fam.ids) AND ${LIVE}) AS n
           FROM tops t
           CROSS JOIN LATERAL (
             SELECT array_agg(x.id) AS ids
               FROM (SELECT t.id UNION SELECT ch.id FROM agreements ch WHERE ch.parent_id = t.id) x
           ) fam
          ORDER BY (t.status = 'executed') DESC, t.id DESC`, [partyId]);
      const nodes: DeskNode[] = (r.rows as any[]).map((x) => ({
        key: `agreement:${x.id}`, kind: "agreement" as const, id: Number(x.id),
        label: [str(x.agreement_no), String(x.title ?? "")].filter(Boolean).join(" "),
        sub: [x.kind === "standalone" ? "単体契約" : "基本契約", x.direction === "out" ? "OUT" : "IN", statusLabel(String(x.status)),
              dateStr(x.expires_on) ? `満了 ${dateStr(x.expires_on)}` : null].filter(Boolean).join(" ・ "),
        count: Number(x.n ?? 0), expandable: false,
        agreementIds: (Array.isArray(x.ids) ? x.ids : []).map((v: unknown) => int(v)).filter((v: number | null): v is number => v !== null)
      }));
      const all = nodes.flatMap((n) => n.agreementIds ?? []);
      const loose = await this.database.query(
        `SELECT count(*)::int AS n FROM conditions c
          WHERE c.counterparty_id = $1 AND ${LIVE}
            AND (c.agreement_id IS NULL OR NOT (c.agreement_id = ANY($2::bigint[])))`, [partyId, all]);
      const n = Number((loose.rows[0] as any)?.n ?? 0);
      if (n > 0) {
        nodes.push({ key: `loose:${partyId}`, kind: "loose", id: null, label: "契約に紐づかない条件",
                     sub: "発注書の約款・未登録の契約", count: n, expandable: false, agreementIds: all });
      }
      return nodes;
    } catch (error) { throw translate(error); }
  }
}

const statusLabel = (s: string): string =>
  ({ draft: "下書き", negotiating: "交渉中", executed: "締結済", expired: "満了", terminated: "解除" } as Record<string, string>)[s] ?? s;
