import type { LegalSearchResult, AgreementLine, PartyStatus } from "../search/legal-search.js";
import type { SearchHit } from "../search/repository.js";

/**
 * Slack の /法務検索。V1 は GAS がモーダルを開き、release/api が契約状況を返していた。
 *
 *   /法務検索 キーワード … その場で結果を返す（本人にだけ見える）
 *   /法務検索            … 検索フォームを開き、送信で同じモーダルを結果に差し替える
 *
 * 組み立ては純関数。Slack を相手にせずに文面を確かめられるようにするため。
 */

export const SEARCH_COMMANDS = new Set(["/法務検索", "/legal-search"]);
export const SEARCH_CALLBACK_ID = "legalbridge_search";

/** Slack のモーダルは 100 ブロックまで。余裕を見て切る。 */
const MAX_BLOCKS = 90;
/** section の本文は 3000 字まで。 */
const MAX_TEXT = 2900;

export function buildSearchModal(initialKeyword = "") {
  return {
    type: "modal",
    callback_id: SEARCH_CALLBACK_ID,
    title: { type: "plain_text", text: "法務検索" },
    submit: { type: "plain_text", text: "検索" },
    close: { type: "plain_text", text: "閉じる" },
    blocks: [
      {
        type: "input", block_id: "keyword",
        label: { type: "plain_text", text: "検索キーワード" },
        element: {
          type: "plain_text_input", action_id: "value", min_length: 2, max_length: 100,
          ...(initialKeyword ? { initial_value: initialKeyword.slice(0, 100) } : {}),
          placeholder: { type: "plain_text", text: "取引先名、案件番号、文書番号、REQ 番号、Backlog キーなど" }
        }
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn",
          text: "取引先に当たれば契約の状況を、番号に当たればその案件・文書・依頼を出します。部分一致です。" }]
      }
    ]
  };
}

export function parseSearchSubmission(payload: any): string {
  return String(payload?.view?.state?.values?.keyword?.value?.value ?? "").trim();
}

const AGREEMENT_STATUS: Record<string, string> = {
  draft: "作成中", negotiating: "交渉中", executed: "締結済", expired: "期間満了", terminated: "解約"
};
const AGREEMENT_KIND: Record<string, string> = {
  master: "基本契約", standalone: "単発の契約", supplement: "覚書・変更", termination: "解約合意"
};
const MATTER_STATUS: Record<string, string> = {
  open: "進行中", waiting: "相手方待ち", blocked: "止まっている", done: "完了", canceled: "中止"
};
const REQUEST_STATE: Record<string, string> = {
  new: "未処理", on_hold: "保留", accepted: "受付済", duplicate: "重複", dismissed: "対象外"
};
const DOCUMENT_STATUS: Record<string, string> = {
  draft: "下書き", issued: "発行済", superseded: "差し替え済", void: "無効"
};
const HIT_LABEL: Record<string, string> = {
  matter: "案件", condition: "条件", document: "文書", work: "作品"
};

const VERDICT_ICON: Record<string, string> = {
  covered: "✅", expiring: "🟡", expired: "⚠️", terminated: "⚠️", none: "⚠️", ambiguous: "🔍"
};

/** 今の終了日。自動更新で当初の終了日から動いていればそちらを出す。 */
const period = (a: AgreementLine) => {
  const end = a.currentEnd ?? a.expiresOn;
  if (!a.effectiveOn && !end) return "";
  const range = `${a.effectiveOn ?? "?"}〜${end ?? ""}`;
  return a.autoRenewal ? `${range}（自動更新）` : range;
};

const agreementLine = (a: AgreementLine) =>
  `・${a.agreementNo ? `\`${a.agreementNo}\` ` : ""}${a.title}　${AGREEMENT_STATUS[a.status] ?? a.status}`
  + (period(a) ? `　${period(a)}` : "")
  + (a.kind !== "master" ? `　${AGREEMENT_KIND[a.kind] ?? a.kind}` : "");

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: clip(text) } });

function partyBlocks(p: PartyStatus): any[] {
  const head = `*🏢 ${p.name}*${p.partyCode ? `　\`${p.partyCode}\`` : ""}　_${p.matchedOn}_`
    + `\n${VERDICT_ICON[p.verdict] ?? ""} ${p.message}`
    + (p.needsLegalReview ? "\n👉 法務の確認が必要です。/法務依頼 で相談してください。" : "");
  const masters = p.agreements.filter((a) => a.kind === "master");
  const others = p.agreements.filter((a) => a.kind !== "master");
  const parts: string[] = [];
  if (masters.length) parts.push(`*基本契約*\n${masters.slice(0, 8).map(agreementLine).join("\n")}`);
  if (others.length) parts.push(`*個別の契約・覚書*\n${others.slice(0, 8).map(agreementLine).join("\n")}`
    + (others.length > 8 ? `\n…ほか ${others.length - 8} 件` : ""));
  if (p.documents.length) parts.push(`*直近の文書*\n${p.documents.map((d) =>
    `・${d.documentNo ? `\`${d.documentNo}\` ` : ""}${d.label}　${d.issuedOn ?? ""}`).join("\n")}`);
  if (p.openMatters.length) parts.push(`*進行中の案件*\n${p.openMatters.map((m) =>
    `・${m.matterNo ? `\`${m.matterNo}\` ` : ""}${m.title}　${MATTER_STATUS[m.status] ?? m.status}`).join("\n")}`);
  return [section(head), ...(parts.length ? [section(parts.join("\n\n"))] : [])];
}

const hitLine = (h: SearchHit) =>
  `・${HIT_LABEL[h.target] ?? h.target}　${h.code ? `\`${h.code}\` ` : ""}${h.title}`
  + (h.context ? `　${h.target === "document" ? h.context.split("・").map((s) => DOCUMENT_STATUS[s] ?? s).join("・") : h.context}` : "");

/** 結果を Block Kit に。 */
export function renderSearchBlocks(
  result: LegalSearchResult, options: { backlogHost?: string; backlogProjectKey?: string } = {}
): any[] {
  const blocks: any[] = [section(`*🔎 検索結果：\`${result.keyword}\`*`)];

  if (result.keyword.length < 2) {
    blocks.push(section("2文字以上で検索してください。"));
    return blocks;
  }

  let found = false;
  if (result.party) {
    found = true;
    blocks.push({ type: "divider" }, ...partyBlocks(result.party));
  }
  if (result.partyNames.length) {
    found = true;
    blocks.push({ type: "divider" }, section(
      `*🏢 取引先の候補が ${result.partyNames.length} 件あります。名前を絞って検索してください。*\n`
      + result.partyNames.map((n) => `・${n}`).join("\n")));
  }
  if (result.backlogMatters.length) {
    found = true;
    blocks.push({ type: "divider" }, section(`*📌 Backlog の課題に繋がっている案件*\n${result.backlogMatters.map((m) =>
      `・${m.issueKey} → ${m.matterNo ? `\`${m.matterNo}\` ` : ""}${m.title}　${MATTER_STATUS[m.status] ?? m.status}`).join("\n")}`));
  }
  if (result.requests.length) {
    found = true;
    blocks.push({ type: "divider" }, section(`*📥 法務への依頼*\n${result.requests.map((r) =>
      `・${r.requestNo ? `\`${r.requestNo}\` ` : ""}${r.title}　${REQUEST_STATE[r.state] ?? r.state}`
      + (r.matterNo ? `　→ 案件 \`${r.matterNo}\`` : "")
      + (r.backlogIssueKey ? `　${r.backlogIssueKey}` : "")).join("\n")}`));
  }
  if (result.hits.length) {
    found = true;
    blocks.push({ type: "divider" }, section(`*📄 案件・文書・条件・作品*\n${result.hits.map(hitLine).join("\n")}`));
  }
  if (!found) {
    blocks.push(section("見つかりませんでした。取引先は登録されている正式名称の一部で、番号は `MTR-2026-00012` のような形で試してください。"));
  }

  if (options.backlogHost && options.backlogProjectKey) {
    const url = `https://${options.backlogHost}/find/${encodeURIComponent(options.backlogProjectKey)}`
      + `?simpleSearch=${encodeURIComponent(result.keyword)}`;
    blocks.push({ type: "divider" }, {
      type: "actions",
      elements: [{ type: "button", action_id: "open_backlog",
                   text: { type: "plain_text", text: "🔗 Backlog で関連課題を検索" }, url }]
    });
  }
  return blocks.length > MAX_BLOCKS ? [...blocks.slice(0, MAX_BLOCKS - 1), section("…多すぎるので省きました。絞って検索してください。")] : blocks;
}

/** 通知やスクリーンリーダー向けの一行。 */
export function searchSummaryText(result: LegalSearchResult): string {
  const n = (result.party ? 1 : 0) + result.partyNames.length + result.hits.length
    + result.requests.length + result.backlogMatters.length;
  return `法務検索「${result.keyword}」：${n ? `${n} 件` : "該当なし"}`;
}

/** 送信後にモーダルを結果へ差し替える view。 */
export function buildSearchResultView(blocks: any[]) {
  return {
    type: "modal",
    callback_id: `${SEARCH_CALLBACK_ID}_result`,
    title: { type: "plain_text", text: "法務検索：結果" },
    close: { type: "plain_text", text: "閉じる" },
    blocks
  };
}
