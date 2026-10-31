/**
 * 左のメニュー（docs/navigation.md）。
 *
 *   ホーム
 *   格納情報の登録・編集 … 取引先・作品・契約・条件明細・文書（台帳）
 *   作業               … 受付・取引開始作業・支払処理作業（日々の流れ）
 *   一括処理           … まとめて登録・更新する／作る・送る／直す・整理する／書き出す
 *   マネージメント     … 案件・稟議
 *   監査               … 点検・取り残し／フロー監視・期限／関連当事者／監査レポート・記録
 *   設定（いちばん下）
 *
 * メニューの 1 項目（hub）は、今ある画面（view。運用の画面はタブ sub まで）を 1 つ以上タブで束ねる。
 * 画面と URL はそのまま使うので、ほかの画面からの飛び先（setView）も古いブックマークも変わらない。
 * どの項目を光らせるかは、いま開いている画面から決める（同じ画面が 2 つの項目にあれば、最後に押した方）。
 */

export type NavView = "home" | "intake" | "daily" | "matters" | "workbench" | "paydocs" | "deals" | "agreements"
  | "agreement-map" | "conditions" | "works" | "parties" | "documents" | "ringi" | "rpt" | "closing" | "money" | "drift"
  | "flows" | "ops" | "condition-check";

/**
 * 開く先。運用（ops）はタブ（sub）まで指す。取引開始作業（workbench）の sub は一括のモード
 * （orders＝発注書を CSV で／settled＝検収済みを遡って）で、作業テーブルを一括で開く。
 */
export interface NavTarget { view: NavView; sub?: string }
export interface NavTab { label: string; to: NavTarget; adminOnly?: boolean }
export interface NavHub {
  key: string; label: string;
  /** 押したときに開くのは先頭のタブ。 */
  tabs: NavTab[];
  /** 画面の上に出す一言（運用の画面を束ねた項目は、運用の見出しの代わりにこれを出す）。 */
  hint?: string;
}
export interface NavSection { section: string | null; hubs: NavHub[] }

const one = (key: string, label: string, view: NavView): NavHub => ({ key, label, tabs: [{ label, to: { view } }] });
const ops = (sub: string) => ({ view: "ops" as const, sub });

export const NAV: NavSection[] = [
  { section: null, hubs: [one("home", "ホーム", "home")] },
  { section: "格納情報の登録・編集", hubs: [
    one("parties", "取引先", "parties"),
    one("works", "作品", "works"),
    { key: "agreements", label: "契約", tabs: [
      { label: "契約", to: { view: "agreements" } },
      // 取引先ごとの基本契約の木。画面によって基本契約の見え方が違う原因（ずれ）を直す。
      { label: "取引先⇔基本契約", to: { view: "agreement-map" } }
    ] },
    one("conditions", "条件明細", "conditions"),
    one("documents", "文書", "documents")
  ] },
  { section: "作業", hubs: [
    // 依頼はまず受付箱に入り、そこで振り分ける（docs/v3-request-inbox.md）。軽微ならデイリータスク、大きければ案件。
    { key: "reception", label: "受付", tabs: [
      { label: "受付箱", to: { view: "intake" } },
      { label: "デイリータスク", to: { view: "daily" } }
    ] },
    // 文書を作る・登録する・繋ぐのはこの 1 枚だけ（作業テーブル）。
    { key: "start", label: "取引開始作業", tabs: [{ label: "取引開始作業", to: { view: "workbench" } }] },
    // 入金・報告・製造から、計算書・検収書を出して払うまで（A-074 の支払文書を中心に）。
    { key: "payment", label: "支払処理作業", tabs: [
      { label: "支払文書", to: { view: "paydocs" } },
      { label: "入金（取引管理）", to: { view: "deals" } },
      { label: "まとめて締める", to: { view: "closing" } },
      { label: "支払・お金", to: { view: "money" } }
    ] }
  ] },
  { section: "一括処理", hubs: [
    { key: "bulk-register", label: "まとめて登録・更新する", hint: "取引先・作品・契約・条件明細を CSV で入れる・直す。取り込む前に試して、結果を確かめてから反映します",
      tabs: [{ label: "まとめて登録・更新する", to: ops("imports") }] },
    { key: "bulk-make", label: "まとめて作る・送る", hint: "文書を何通もまとめて起こす・送る",
      tabs: [
        { label: "発注書（CSV）", to: { view: "workbench", sub: "orders" } },
        { label: "契約書（契約の無い相手先）", to: ops("contracts") },
        { label: "計算書・検収書（まとめて締める）", to: { view: "closing" } },
        { label: "まとめて送る", to: ops("sending") }
      ] },
    { key: "bulk-fix", label: "まとめて直す・整理する", hint: "契約期間の既定・通知先・計算書の統合・支払日などをまとめて直す。過去の取引をさかのぼって入れる",
      tabs: [
        { label: "一括修正", to: ops("fixes") },
        { label: "過去分を入れる（検収済み）", to: { view: "workbench", sub: "settled" } }
      ] },
    { key: "bulk-export", label: "書き出す", hint: "会計へ渡す・一覧を CSV で書き出す（取り込みはしない）",
      tabs: [{ label: "書き出す", to: ops("exports") }] }
  ] },
  { section: "マネージメント", hubs: [
    one("matters", "案件", "matters"),
    // 稟議（R-）と取締役会決議（B-）。文書・契約に繋いで /法務検索 で引ける。
    one("ringi", "稟議", "ringi")
  ] },
  { section: "監査", hubs: [
    { key: "check", label: "点検・取り残し", hint: "データの不整合と、条件を直したあとに取り残された金額・日付",
      tabs: [
        { label: "データ品質", to: ops("quality") },
        // 重複・決済の型が空・根拠の文書なし・作者に届かない許諾（server/conditions/check-service.ts）。
        { label: "条件の点検", to: { view: "condition-check" } },
        { label: "金額の取り残し", to: { view: "drift" } }
      ] },
    { key: "monitor", label: "フロー監視・期限", hint: "取適法・債権・契約チェック・作品運用と、近づく期限",
      tabs: [
        { label: "フロー監視", to: { view: "flows" } },
        { label: "期限", to: ops("deadlines") }
      ] },
    // 取引が会社法の利益相反・会計の関連当事者に当たるかの判定と、取締役会の議案。
    one("rpt", "関連当事者", "rpt"),
    { key: "audit", label: "監査レポート・記録", hint: "監査記録は追記専用の 1 本。送付も無効化も同じ形で残る",
      tabs: [
        { label: "監査レポート", to: ops("audit-report") },
        { label: "監査記録", to: ops("audit") }
      ] }
  ] },
  { section: null, hubs: [
    { key: "settings", label: "設定", hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ",
      tabs: [
        { label: "定型文", to: ops("snippets") },
        { label: "計算書の表示", to: ops("statement-models") },
        { label: "外部連携", to: ops("integrations") },
        { label: "片づけ", to: ops("leftovers") },
        { label: "設定", to: ops("settings"), adminOnly: true }
      ] }
  ] }
];

export const ALL_HUBS: NavHub[] = NAV.flatMap((s) => s.hubs);

/** メニューから開ける画面すべて（URL から来た画面を受けるかどうか）。 */
export const NAV_VIEWS: Set<string> = new Set(ALL_HUBS.flatMap((h) => h.tabs.map((t) => t.to.view)));

/**
 * その画面がこのタブか。運用はタブまで見る（タブ未指定の運用はデータ品質）。ほかの画面は、
 * タブが sub を指していれば sub まで、指していなければ画面だけで当てる。
 * 返す値：0＝当たらない、1＝画面だけ当たる、2＝sub まで当たる（光らせる項目はこちらを先に選ぶ）。
 */
export function tabMatches(tab: NavTab, view: string, sub?: string | null): 0 | 1 | 2 {
  if (tab.to.view !== view) return 0;
  if (view === "ops") return (tab.to.sub ?? "quality") === (sub || "quality") ? 2 : 0;
  if (tab.to.sub) return tab.to.sub === sub ? 2 : 0;
  return 1;
}

/** 管理者だけのタブを除いたタブ。 */
export const visibleTabs = (hub: NavHub, admin: boolean): NavTab[] => hub.tabs.filter((t) => admin || !t.adminOnly);

/**
 * いま光らせるメニュー項目。最後に押した項目がこの画面を持っていればそれ、無ければ先に並ぶ項目。
 * どこにも無い画面（メニューの外）は null。
 */
export function activeHub(view: string, sub: string | null | undefined, lastHubKey: string | null): NavHub | null {
  const score = (h: NavHub) => Math.max(0, ...h.tabs.map((t) => tabMatches(t, view, sub)));
  const last = lastHubKey ? ALL_HUBS.find((h) => h.key === lastHubKey) : undefined;
  // sub まで当たる項目が先（案件から「発注書を CSV で」を開いたら、取引開始作業ではなく一括処理を光らせる）。
  if (last && score(last) === 2) return last;
  const exact = ALL_HUBS.find((h) => score(h) === 2);
  if (exact) return exact;
  if (last && score(last) === 1) return last;
  return ALL_HUBS.find((h) => score(h) === 1) ?? null;
}

/** 光らせる項目の中で、いま開いているタブ。 */
export function activeTab(hub: NavHub, view: string, sub?: string | null): NavTab | null {
  return hub.tabs.find((t) => tabMatches(t, view, sub) === 2) ?? hub.tabs.find((t) => tabMatches(t, view, sub) === 1) ?? null;
}
