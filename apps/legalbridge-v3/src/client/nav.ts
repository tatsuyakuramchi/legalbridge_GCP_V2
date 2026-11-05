/**
 * 左のメニュー（docs/navigation.md・docs/desk-home.md）。UI 再構築の手順 2 で 4 項目にした。
 *
 *   ホーム       … 今日やること（受信箱）と畳んだ作業台。受付箱・デイリータスクもここのタブ
 *   作業台       … 取引先・案件・作品のツリー（全幅）。台帳の画面と、日々の作業の画面もここのタブ
 *   一括処理     … 支払文書・まとめて締める・まとめて登録・更新する／作る・送る／直す・整理する／書き出す
 *   監査・設定   … 点検・取り残し／フロー監視・期限・関連当事者／監査レポート・記録／設定
 *
 * メニューの 1 項目（hub）は、今ある画面（view。運用の画面はタブ sub まで）を 1 つ以上タブで束ねる。
 * 画面と URL はそのまま使うので、ほかの画面からの飛び先（setView）も古いブックマークも変わらない。
 * タブの多い項目は group で小さな見出しを付けて並べる。
 * どの項目を光らせるかは、いま開いている画面から決める（同じ画面が 2 つの項目にあれば、最後に押した方）。
 */

export type NavView = "home" | "desk" | "intake" | "daily" | "matters" | "workbench" | "paydocs" | "deals" | "agreements"
  | "agreement-map" | "conditions" | "works" | "parties" | "documents" | "ringi" | "rpt" | "closing" | "money" | "drift"
  | "flows" | "ops" | "condition-check";

/**
 * 開く先。運用（ops）はタブ（sub）まで指す。取引開始作業（workbench）の sub は一括のモード
 * （orders＝発注書を CSV で／settled＝検収済みを遡って）で、作業テーブルを一括で開く。
 */
export interface NavTarget { view: NavView; sub?: string }
export interface NavTab {
  label: string; to: NavTarget; adminOnly?: boolean;
  /** タブの並びの小見出し。前のタブと違うときだけ出す。 */
  group?: string;
  /** 運用の画面の見出しの下に出す一言（運用の見出しの代わり）。 */
  hint?: string;
}
export interface NavHub {
  key: string; label: string;
  /** 押したときに開くのは先頭のタブ。 */
  tabs: NavTab[];
  /** 画面の上に出す一言（タブに hint が無いときの既定）。 */
  hint?: string;
}
export interface NavSection { section: string | null; hubs: NavHub[] }

const ops = (sub: string) => ({ view: "ops" as const, sub });

export const NAV: NavSection[] = [
  { section: null, hubs: [
    // 今日やること（受付箱・デイリータスク・期限）を 1 本にした受信箱。元の一覧もタブで残す。
    { key: "home", label: "ホーム", tabs: [
      { label: "ホーム", to: { view: "home" } },
      { label: "受付箱", to: { view: "intake" }, group: "受付" },
      { label: "デイリータスク", to: { view: "daily" }, group: "受付" }
    ] },
    // 取引先・案件・作品のツリー。台帳の画面と日々の作業の画面は、吸収するまでタブで残す。
    { key: "desk", label: "作業台", tabs: [
      { label: "作業台", to: { view: "desk" } },
      { label: "案件", to: { view: "matters" }, group: "台帳" },
      { label: "取引先", to: { view: "parties" }, group: "台帳" },
      { label: "作品", to: { view: "works" }, group: "台帳" },
      { label: "契約", to: { view: "agreements" }, group: "台帳" },
      // 取引先ごとの基本契約の木。画面によって基本契約の見え方が違う原因（ずれ）を直す。
      { label: "取引先⇔基本契約", to: { view: "agreement-map" }, group: "台帳" },
      { label: "条件明細", to: { view: "conditions" }, group: "台帳" },
      { label: "文書", to: { view: "documents" }, group: "台帳" },
      // 稟議（R-）と取締役会決議（B-）。文書・契約に繋いで /法務検索 で引ける。
      { label: "稟議", to: { view: "ringi" }, group: "台帳" },
      // 文書を作る・登録する・繋ぐのはこの 1 枚だけ（作業テーブル）。
      { label: "取引開始作業", to: { view: "workbench" }, group: "作業" },
      { label: "入金（取引管理）", to: { view: "deals" }, group: "作業" },
      { label: "支払・お金", to: { view: "money" }, group: "作業" }
    ] },
    { key: "bulk", label: "一括処理", hint: "何件もまとめて作る・送る・直す・書き出す", tabs: [
      // 入金・報告・製造から、計算書・検収書を出して払うまで（A-074 の支払文書を中心に）。
      { label: "支払文書", to: { view: "paydocs" }, group: "支払" },
      { label: "まとめて締める", to: { view: "closing" }, group: "支払" },
      { label: "まとめて登録・更新する", to: ops("imports"), group: "登録・作る・送る",
        hint: "取引先・作品・契約・条件明細を CSV で入れる・直す。取り込む前に試して、結果を確かめてから反映します" },
      { label: "発注書（CSV）", to: { view: "workbench", sub: "orders" }, group: "登録・作る・送る" },
      { label: "契約書（契約の無い相手先）", to: ops("contracts"), group: "登録・作る・送る", hint: "文書を何通もまとめて起こす・送る" },
      { label: "まとめて送る", to: ops("sending"), group: "登録・作る・送る", hint: "文書を何通もまとめて起こす・送る" },
      { label: "一括修正", to: ops("fixes"), group: "直す・書き出す",
        hint: "契約期間の既定・通知先・計算書の統合・支払日などをまとめて直す。過去の取引をさかのぼって入れる" },
      { label: "過去分を入れる（検収済み）", to: { view: "workbench", sub: "settled" }, group: "直す・書き出す" },
      { label: "書き出す", to: ops("exports"), group: "直す・書き出す", hint: "会計へ渡す・一覧を CSV で書き出す（取り込みはしない）" }
    ] },
    { key: "audit", label: "監査・設定", tabs: [
      { label: "データ品質", to: ops("quality"), group: "点検",
        hint: "データの不整合と、条件を直したあとに取り残された金額・日付" },
      // 重複・決済の型が空・根拠の文書なし・作者に届かない許諾（server/conditions/check-service.ts）。
      { label: "条件の点検", to: { view: "condition-check" }, group: "点検" },
      { label: "金額の取り残し", to: { view: "drift" }, group: "点検" },
      { label: "フロー監視", to: { view: "flows" }, group: "監視" },
      { label: "期限", to: ops("deadlines"), group: "監視", hint: "取適法・債権・契約チェック・作品運用と、近づく期限" },
      // 取引が会社法の利益相反・会計の関連当事者に当たるかの判定と、取締役会の議案。
      { label: "関連当事者", to: { view: "rpt" }, group: "監視" },
      { label: "監査レポート", to: ops("audit-report"), group: "記録", hint: "監査記録は追記専用の 1 本。送付も無効化も同じ形で残る" },
      { label: "監査記録", to: ops("audit"), group: "記録", hint: "監査記録は追記専用の 1 本。送付も無効化も同じ形で残る" },
      { label: "定型文", to: ops("snippets"), group: "設定", hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ" },
      { label: "計算書の表示", to: ops("statement-models"), group: "設定", hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ" },
      { label: "外部連携", to: ops("integrations"), group: "設定", hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ" },
      { label: "片づけ", to: ops("leftovers"), group: "設定", hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ" },
      { label: "設定", to: ops("settings"), group: "設定", adminOnly: true, hint: "会社情報・メール文面・定型文・計算書の表示・外部連携・片づけ" }
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
  // sub まで当たる項目が先（案件から「発注書を CSV で」を開いたら、作業台ではなく一括処理を光らせる）。
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
