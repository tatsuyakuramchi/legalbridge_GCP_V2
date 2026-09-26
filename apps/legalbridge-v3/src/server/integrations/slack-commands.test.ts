import test from "node:test";
import assert from "node:assert/strict";
import { MemoryViewOpener } from "./adapters.js";
import { SlackCommandHandler } from "./slack-commands.js";
import { SEARCH_CALLBACK_ID, renderSearchBlocks } from "./slack-search.js";
import { INTAKE_CALLBACK_ID } from "./slack-intake.js";
import type { LegalSearchResult } from "../search/legal-search.js";

const result = (over: Partial<LegalSearchResult> = {}): LegalSearchResult => ({
  keyword: "株式会社甲", party: null, partyNames: [], hits: [], requests: [], backlogMatters: [], ringi: [], ...over
});
const covered: LegalSearchResult["party"] = {
  partyCode: "PTY-5", name: "株式会社甲", matchedOn: "正式名称と一致",
  verdict: "covered", message: "株式会社甲 とは有効な基本契約があります（2030-01-01 まで）。", needsLegalReview: false,
  agreements: [{ id: 1, agreementNo: "AGR-1", title: "業務委託基本契約", status: "executed", kind: "master",
                 effectiveOn: "2025-01-01", expiresOn: "2027-01-01", autoRenewal: true,
                 currentEnd: "2030-01-01", terminatedOn: null, daysToExpiry: 1000 }],
  documents: [{ documentNo: "ARC-PO-2026-1001", label: "発注書", status: "issued", issuedOn: "2026-09-01" }],
  openMatters: [{ matterNo: "MTR-2026-00012", title: "イラスト制作", status: "open" }]
};

const handler = (over: { views?: MemoryViewOpener | null; channels?: string[]; found?: LegalSearchResult } = {}) => {
  const views = over.views === undefined ? new MemoryViewOpener() : over.views;
  const searched: string[] = [];
  const audits: any[] = [];
  const h = new SlackCommandHandler({
    search: async (k) => { searched.push(k); return over.found ?? result({ keyword: k }); },
    views, searchChannels: over.channels ?? [],
    backlogHost: "arclight.backlog.com", backlogProjectKey: "LEGAL",
    audit: async (e) => { audits.push(e); }
  });
  return { h, views, searched, audits };
};

test("/法務依頼 は views.open でモーダルを開く（応答本文では開けない）", async () => {
  const { h, views } = handler();
  const reply = await h.command({ command: "/法務依頼", trigger_id: "T1", channel_id: "C1" });
  assert.equal(views!.opened.length, 1);
  assert.equal(views!.opened[0].triggerId, "T1");
  assert.equal(views!.opened[0].view.callback_id, INTAKE_CALLBACK_ID);
  assert.equal(reply.response_type, "ephemeral");
});

test("トークンが無くて開けないときは、黙らずに文字で知らせる", async () => {
  const { h } = handler({ views: null });
  const reply = await h.command({ command: "/法務依頼", trigger_id: "T1" });
  assert.match(String(reply.text), /開けませんでした/);
});

test("/法務検索 キーワード はその場で本人にだけ結果を返す", async () => {
  const { h, views, searched, audits } = handler({ found: result({ party: covered }) });
  const reply = await h.command({ command: "/法務検索", text: " 株式会社甲 ", user_id: "U1", trigger_id: "T1" });
  assert.deepEqual(searched, ["株式会社甲"]);
  assert.equal(views!.opened.length, 0, "キーワード付きはモーダルを挟まない");
  assert.equal(reply.response_type, "ephemeral");
  const text = JSON.stringify(reply.blocks);
  assert.match(text, /有効な基本契約があります/);
  assert.match(text, /ARC-PO-2026-1001/);
  assert.match(text, /2025-01-01〜2030-01-01（自動更新）/, "自動更新なら今の終了日を出す");
  assert.deepEqual(audits, [{ userId: "U1", keyword: "株式会社甲", hits: 1 }]);
});

test("/法務検索 だけならフォームを開き、送信で同じモーダルを結果に差し替える", async () => {
  const { h, views } = handler({ found: result({ party: covered }) });
  await h.command({ command: "/法務検索", text: "", trigger_id: "T2" });
  assert.equal(views!.opened[0].view.callback_id, SEARCH_CALLBACK_ID);

  const payload = { type: "view_submission", user: { id: "U1" },
    view: { callback_id: SEARCH_CALLBACK_ID, state: { values: { keyword: { value: { value: "株式会社甲" } } } } } };
  assert.equal(h.isSearchSubmission(payload), true);
  const reply = await h.searchSubmission(payload) as any;
  assert.equal(reply.response_action, "update");
  assert.match(JSON.stringify(reply.view.blocks), /株式会社甲/);
});

test("短すぎる送信はフォームにエラーを出して閉じさせない", async () => {
  const { h } = handler();
  const reply = await h.searchSubmission({ type: "view_submission",
    view: { callback_id: SEARCH_CALLBACK_ID, state: { values: { keyword: { value: { value: "甲" } } } } } }) as any;
  assert.equal(reply.response_action, "errors");
});

test("許可したチャンネル以外では使わせない（V1 の ALLOWED_SEARCH_CHANNEL_IDS）", async () => {
  const { h, searched } = handler({ channels: ["C_LEGAL"] });
  const reply = await h.command({ command: "/法務検索", text: "甲社", channel_id: "C_OTHER" });
  assert.match(String(reply.text), /このチャンネルでは使えません/);
  assert.equal(searched.length, 0);
});

test("受付フォームの送信は検索として扱わない", () => {
  const { h } = handler();
  assert.equal(h.isSearchSubmission({ type: "view_submission", view: { callback_id: INTAKE_CALLBACK_ID } }), false);
});

// ---- 文面 ----

test("法務の確認が要る判定なら、/法務依頼 へ案内する", () => {
  const blocks = renderSearchBlocks(result({ party: { ...covered!, verdict: "expired", needsLegalReview: true,
    message: "株式会社甲 との契約は 2026-01-01 に満了しています。" } }));
  const text = JSON.stringify(blocks);
  assert.match(text, /満了しています/);
  assert.match(text, /\/法務依頼 で相談/);
});

test("候補が多いときは名前を並べて絞らせる。何も無ければそう言う", () => {
  assert.match(JSON.stringify(renderSearchBlocks(result({ partyNames: ["株式会社甲", "株式会社甲乙"] }))), /2 件あります/);
  assert.match(JSON.stringify(renderSearchBlocks(result())), /見つかりませんでした/);
});

test("Backlog の画面で探すボタンを付ける（キーワードは URL に符号化）", () => {
  const blocks = renderSearchBlocks(result({ keyword: "NDA 確認" }), { backlogHost: "arclight.backlog.com", backlogProjectKey: "LEGAL" });
  const button = blocks.at(-1).elements[0];
  assert.equal(button.url, "https://arclight.backlog.com/find/LEGAL?simpleSearch=NDA%20%E7%A2%BA%E8%AA%8D");
});
