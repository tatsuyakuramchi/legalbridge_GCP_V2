import type { Queryable } from "../core/db.js";
import { translate } from "../core/errors.js";

/**
 * ホームの「5 駅で待っているもの」（docs/v3-tidy.md 工程ナビ）。
 *
 * 本線は ① 登録 → ② 作る → ③ 確かめる → ④ 送る → ⑤ 記録。ホームは「まとめて」の切り口で、
 * 駅ごとに待っている件数を札にし、押すとその駅の画面へ行く。数は各画面の表と同じ道具で数える
 * （画面ごとの集計差を作らない）。
 */

export type StationNo = 1 | 2 | 3 | 4 | 5;

export interface StationCard {
  key: string;
  label: string;
  count: number;
  /** 行き先。view は App の画面名。tab＝運用のタブ、tile＝支払文書の札、mode＝取引先⇔基本契約の切り替え。 */
  go: { view: string; tab?: string; tile?: string; mode?: string };
  /** 件数の単位の補足（「14 枚・6 相手先」）。 */
  sub?: string;
}

export interface HomeStations {
  stations: Array<{ no: StationNo; cards: StationCard[] }>;
}

/** 数える道具。テストで差し替えられるように、要るメソッドだけ受け取る。 */
export interface StationTools {
  intake: { counts(): Promise<{ new: number; updated: number }> };
  tasks: { counts(assignee: number | null): Promise<{ open: number }> };
  unsent: { list(): Promise<{ bundles: Array<{ docs: unknown[] }> }> };
  missing: { list(): Promise<{ parties: unknown[] }> };
  paydocs: { list(q: { view: "todo" }): Promise<{ tiles: Record<string, number> }> };
  term: { preview(): Promise<{ targets: Array<{ skip: string | null }> }> };
  notice: { preview(staff: null): Promise<{ targets: Array<{ skip: string | null }> }> };
  statements: { preview(): Promise<{ groups: Array<{ status: string }> }> };
  tidy: { parties(q: { issuesOnly: boolean }): Promise<Array<{ marks: number }>> };
}

const CONTRACT_KEYS = `(t.template_key ~ '(master|terms)' )`;

/** 盤面の数を覚えておく時間。画面を開き直すたびに 10 本の集計を回さない。 */
const CACHE_MS = 60_000;

export class HomeStationsService {
  constructor(private readonly database: Queryable, private readonly tools: StationTools) {}

  private cache: { at: number; value: HomeStations } | null = null;
  private inflight: Promise<HomeStations> | null = null;

  /**
   * 10 本の集計を一度に走らせない。それぞれが中で何本も問い合わせを並べるので、全部を Promise.all で
   * 投げると DB の接続プール（10 本）を独り占めし、同時に開いた画面の要求が接続待ち（5 秒）で落ちていた。
   * 2 本ずつ順に回し、結果は 1 分覚える（同時に来た要求は 1 回の計算に相乗り）。
   */
  async stations(): Promise<HomeStations> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.compute()
      .then((value) => { this.cache = { at: Date.now(), value }; return value; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async compute(): Promise<HomeStations> {
    try {
      const safe = <T,>(run: () => Promise<T>, fallback: T) => () => run().catch(() => fallback);
      const jobs = [
        safe(() => this.tools.intake.counts(), { new: 0, updated: 0 }),
        safe(() => this.tools.tasks.counts(null), { open: 0 }),
        safe(() => this.tools.unsent.list(), { bundles: [] as Array<{ docs: unknown[] }> }),
        safe(() => this.tools.missing.list(), { parties: [] as unknown[] }),
        safe(() => this.tools.paydocs.list({ view: "todo" }), { tiles: {} as Record<string, number> }),
        safe(() => this.tools.term.preview(), { targets: [] as Array<{ skip: string | null }> }),
        safe(() => this.tools.notice.preview(null), { targets: [] as Array<{ skip: string | null }> }),
        safe(() => this.tools.statements.preview(), { groups: [] as Array<{ status: string }> }),
        safe(() => this.tools.tidy.parties({ issuesOnly: true }), [] as Array<{ marks: number }>),
        safe(() => this.counts(), { drafts: 0, ownerCheck: 0, signing: 0, planned: 0 })
      ] as const;
      const results = await runLimited(jobs as unknown as Array<() => Promise<unknown>>, 2);
      const [intake, tasks, unsent, missing, paydocs, term, notice, stmts, tidy, sql] = results as [
        { new: number; updated: number }, { open: number }, { bundles: Array<{ docs: unknown[] }> }, { parties: unknown[] },
        { tiles: Record<string, number> }, { targets: Array<{ skip: string | null }> }, { targets: Array<{ skip: string | null }> },
        { groups: Array<{ status: string }> }, Array<{ marks: number }>, { drafts: number; ownerCheck: number; signing: number; planned: number }
      ];
      const tiles = (k: string) => Number(paydocs.tiles[k] ?? 0);
      const fixes = term.targets.filter((t) => !t.skip).length + notice.targets.filter((t) => !t.skip).length
        + stmts.groups.filter((g) => g.status === "ready").length;
      const unsentDocs = unsent.bundles.reduce((a, b) => a + b.docs.length, 0);
      return { stations: [
        { no: 1, cards: [
          { key: "intake", label: "受付箱", count: intake.new + intake.updated, go: { view: "intake" } },
          { key: "daily", label: "デイリータスク", count: tasks.open, go: { view: "daily" } },
          { key: "report", label: "報告・実績待ちの回", count: tiles("wait"), go: { view: "paydocs", tile: "wait" } },
          { key: "tidy", label: "整理する（直すところのある取引先）", count: tidy.filter((p) => p.marks > 0).length, go: { view: "agreement-map", mode: "tidy" } }
        ] },
        { no: 2, cards: [
          { key: "missing", label: "契約なし（条件はあるのに契約書が無い）", count: missing.parties.length, go: { view: "ops", tab: "contracts" } },
          { key: "make", label: "締める回（計算書・検収書を作る）", count: tiles("make"), go: { view: "paydocs", tile: "make" } },
          { key: "drafts", label: "下書きの文書", count: sql.drafts, go: { view: "documents" } }
        ] },
        { no: 3, cards: [
          { key: "owner", label: "担当者確認がまだの契約書", count: sql.ownerCheck, go: { view: "documents" } },
          { key: "paydraft", label: "下書きを確かめて決定する回", count: tiles("draft"), go: { view: "paydocs", tile: "draft" } },
          { key: "fixes", label: "一括修正の残り（許諾期間・通知先・計算書）", count: fixes, go: { view: "ops", tab: "fixes" } }
        ] },
        { no: 4, cards: [
          { key: "unsent", label: "未送付の文書", count: unsentDocs, sub: unsent.bundles.length ? `${unsent.bundles.length} 相手先` : undefined, go: { view: "ops", tab: "sending" } },
          { key: "payunsent", label: "未送付の支払文書", count: tiles("unsent"), go: { view: "paydocs", tile: "unsent" } }
        ] },
        { no: 5, cards: [
          { key: "signing", label: "締結待ち（CloudSign）", count: sql.signing, go: { view: "documents" } },
          { key: "await", label: "受領待ちの回", count: tiles("await"), go: { view: "paydocs", tile: "await" } },
          { key: "overdue", label: "期限超過（報告・受領・支払）", count: tiles("overdue"), go: { view: "paydocs", tile: "overdue" } },
          { key: "planned", label: "支払予定", count: sql.planned, go: { view: "money" } }
        ] }
      ] };
    } catch (error) { throw translate(error); }
  }

  /** SQL で数えるもの：下書き・担当者確認がまだの契約書・締結待ち・支払予定。 */
  private async counts(): Promise<{ drafts: number; ownerCheck: number; signing: number; planned: number }> {
    const r = await this.database.query(
      `SELECT
         (SELECT count(*)::int FROM documents d WHERE d.status = 'draft') AS drafts,
         (SELECT count(*)::int FROM documents d
            JOIN document_template_versions tv ON tv.id = d.template_version_id
            JOIN document_templates t ON t.id = tv.template_id
           WHERE d.status = 'issued' AND ${CONTRACT_KEYS}
             AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.target_type = 'document' AND a.target_id = d.id
                               AND a.action IN ('gmail.review', 'document.confirmed', 'gmail.party_check', 'gmail.send',
                                                'cloudsign.send', 'cloudsign.draft', 'document.sent_manual', 'document.step_skipped'))) AS owner_check,
         (SELECT count(*)::int FROM documents d
           WHERE d.status = 'issued'
             AND EXISTS (SELECT 1 FROM audit_events a WHERE a.target_type = 'document' AND a.target_id = d.id AND a.action = 'cloudsign.send')
             AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.target_type = 'document' AND a.target_id = d.id
                               AND ((a.action = 'cloudsign.applied' AND a.detail->>'applied' = 'true')
                                    OR (a.action = 'document.step_skipped' AND a.detail->>'step' = 'executed')))) AS signing,
         (SELECT count(*)::int FROM payments p WHERE p.status IN ('planned', 'approved')) AS planned`);
    const row = (r.rows[0] ?? {}) as Record<string, unknown>;
    return { drafts: Number(row.drafts ?? 0), ownerCheck: Number(row.owner_check ?? 0), signing: Number(row.signing ?? 0), planned: Number(row.planned ?? 0) };
  }
}

/** 同時に n 本まで。順番どおりの結果を返す。 */
async function runLimited<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}
