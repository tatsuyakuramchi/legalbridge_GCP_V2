import type { SlackWebApiClient } from "../integrations/slack-web-api-adapter.js";
import type { BacklogWriteClient } from "../integrations/backlog-web-api.js";
import type { SlackIntakeRepository } from "./intake-repository.js";
import type { ContractCheckRepository, VendorCandidate } from "../contract-check/repository.js";
import {
  findPurpose, buildMasterContractSummary, buildLicenseConditions, buildPublicationConditions,
  buildPurposeResult, buildSuggestedAction, notFoundResult
} from "../contract-check/engine.js";
import {
  LEGAL_SEARCH_CALLBACK_ID, SEARCH_AGAIN_ACTION_ID, buildLegalSearchModal, parseSearchKeyword,
  buildSearchResultsModal, backlogSearchUrl, type SearchOutcome
} from "./search-modal.js";
import {
  LEGAL_REQUEST_CALLBACK_ID, REQUEST_TYPE_ACTION_ID, DEADLINE_CHANGE_TYPE, NEW_ISSUE_VALUE,
  buildLegalRequestModal, parseLegalRequestSubmission,
  buildCompletionView, buildErrorView, backlogIssueTypeFor, requestTypeLabel,
  type LegalRequestSubmission, type IntakeCandidate
} from "./modal.js";
import {
  LINE_ITEM_ADD_ACTION_ID, LINE_ITEM_REMOVE_ACTION_ID, LINE_ITEM_MAX, formatLineItemsText
} from "./line-items.js";

// /法務依頼 の受付処理（Phase 16-3a → 16-3c で動的モーダル対応）。V1 slackGateway +
// worker processLegalRequestSubmission の移植。Backlog 起票＋DB 書込は view_submission 応答前に
// 同期実行（Slack の 3 秒以内・min-instances 前提は V1 と同じ）。通知はベストエフォート。
// Backlog 未接続（adapter 無し）は dry-run＝隔離台帳のみ記録し、共有表・起票は行わない。
// 16-3c: 依頼種別の dispatch_action・明細行の増減（views.update）・既存課題への紐付け・納期変更依頼。

export interface SlackIntakeHandlerOptions {
  repository: SlackIntakeRepository;
  slack: SlackWebApiClient;
  backlog?: BacklogWriteClient | null;
  backlogHost?: string | null;
  backlogProjectKey?: string | null;
  // /法務検索（16-3b）＋検収書の契約番号実在チェック（16-3c・未注入なら実在チェックはスキップ）。
  contractCheck?: ContractCheckRepository | null;
  // 資料アップロードページのURL（V1ポータル互換）。設定時はモーダルと起票後DMに
  // 課題番号付きリンクを出す。未設定時は法務相談のみDM返信での受け渡しを案内。
  uploadPageUrl?: string | null;
  // 取引先マスタ検索ページのURL。設定時はモーダルの相手方入力に検索リンクを出す。
  vendorSearchUrl?: string | null;
  log?: (message: string) => void;
}

export interface SlackIntakeResult { status: number; body: unknown; }

export const LEGAL_REQUEST_COMMANDS = new Set(["/法務依頼", "/legal-request"]);
export const LEGAL_SEARCH_COMMANDS = new Set(["/法務検索", "/legal-search"]);

function issueUrl(host: string | null | undefined, issueKey: string): string | null {
  const h = String(host ?? "").trim();
  return h ? `https://${h}/view/${issueKey}` : null;
}

// V1 worker（server.ts:2427）に準拠した課題説明文。
export function buildIssueDescription(s: LegalRequestSubmission, requesterEmail: string | null): string {
  const lineItemsText = formatLineItemsText(s.requestType, s.lineItems);
  const lines = [
    `■ 依頼種別: ${requestTypeLabel(s.requestType)}`,
    `■ 件名: ${s.summary}`,
    `■ 希望納期: ${s.deadline}`,
    s.targetDocNumber ? `■ 対象契約番号: ${s.targetDocNumber}` : null,
    s.counterparty ? `■ 相手方: ${s.counterparty}${s.entityType === "individual" ? "（個人）" : ""}` : null,
    s.entityId ? `■ 法人番号/個人コード: ${s.entityId}` : null,
    requesterEmail ? `■ 依頼者: ${requesterEmail}` : null,
    "",
    "■ 相談・依頼詳細:",
    s.details,
    ...(lineItemsText ? ["", lineItemsText] : []),
    "",
    "（Slack /法務依頼 から自動起票・LegalBridge V2）"
  ];
  return lines.filter((l) => l !== null).join("\n");
}

type BlockAction = {
  action_id?: string;
  selected_option?: { value?: string } | null;
};

export function createSlackIntakeHandler(options: SlackIntakeHandlerOptions) {
  const log = options.log ?? (() => undefined);

  async function openModal(triggerId: string): Promise<void> {
    await options.slack.post("views.open", {
      trigger_id: triggerId,
      view: buildLegalRequestModal({
        uploadPageUrl: options.uploadPageUrl, vendorSearchUrl: options.vendorSearchUrl
      })
    });
  }

  // 課題番号を引き継いだアップロードページURL（V1 と同じ ?issue= / &issue= の出し分け）。
  function uploadUrlFor(issueKey: string | null): string | null {
    const base = String(options.uploadPageUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) return null;
    if (!issueKey) return base;
    return `${base}${base.includes("?") ? "&" : "?"}issue=${encodeURIComponent(issueKey)}`;
  }

  // 申請者の未完了依頼候補（ベストエフォート・失敗は空扱い）。
  async function candidatesFor(slackUserId: string, selectedType: string): Promise<IntakeCandidate[]> {
    try {
      if (selectedType === "delivery_inspec" || selectedType === "license_calc") {
        return await options.repository.openRequestCandidates(slackUserId, selectedType);
      }
      if (selectedType === DEADLINE_CHANGE_TYPE) {
        return await options.repository.openRequestCandidates(slackUserId, null);
      }
      return [];
    } catch (error) {
      log(`slack-intake: candidates fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // 依頼者への DM（ベストエフォート）。
  async function dm(slackUserId: string, text: string): Promise<void> {
    try {
      const opened = await options.slack.post("conversations.open", { users: slackUserId }) as
        { ok?: boolean; channel?: { id?: string } };
      if (opened?.ok && opened.channel?.id) {
        await options.slack.post("chat.postMessage", { channel: opened.channel.id, text });
      }
    } catch (error) {
      log(`slack-intake: DM failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 依頼者DM＋部署チャンネル通知（ベストエフォート）。
  async function notify(slackUserId: string, issueKey: string | null, s: LegalRequestSubmission): Promise<void> {
    const link = issueKey ? issueUrl(options.backlogHost, issueKey) : null;
    const keyText = issueKey ? (link ? `<${link}|${issueKey}>` : issueKey) : "（採番なし）";
    // 資料の受け渡し導線（V1 の起票後DM相当）。URL設定時は課題番号入りリンク、
    // 未設定時は法務相談のみDM返信での添付を案内する。
    const uploadTarget = uploadUrlFor(issueKey);
    const attachmentLine = uploadTarget
      ? `📎 レビュー対象文書・参考資料の添付は <${uploadTarget}|資料アップロードページ> からお願いします` +
        (issueKey ? "（課題番号は入力済みで開きます）。" : "。")
      : s.requestType === "legal_consult"
        ? "📎 レビューしてほしい文書・参考資料は、このDMへの返信で添付してください（法務担当が案件へ登録します）。"
        : null;
    const text = [
      "🆕 *新規依頼を受け付けました*",
      `*課題:* ${keyText}`,
      `*種別:* ${requestTypeLabel(s.requestType)}`,
      s.counterparty ? `*相手方:* ${s.counterparty}` : null,
      `*概要:* ${s.summary}`,
      attachmentLine
    ].filter(Boolean).join("\n");
    await dm(slackUserId, text);
    try {
      const staff = await options.repository.staffBySlackId(slackUserId);
      const channel = await options.repository.departmentChannel(staff?.department ?? null);
      if (channel) {
        await options.slack.post("chat.postMessage", {
          channel, text: `<@${slackUserId}> さんの依頼の通知です\n${text}`
        });
      }
    } catch (error) {
      log(`slack-intake: department channel post failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function handleCommand(body: Record<string, string | undefined>): Promise<SlackIntakeResult> {
    const command = String(body.command ?? "").trim();
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { status: 200, body: { response_type: "ephemeral", text: "リクエストが不正です（trigger_id なし）。" } };
    if (LEGAL_SEARCH_COMMANDS.has(command)) {
      if (!options.contractCheck) {
        return { status: 200, body: { response_type: "ephemeral", text: "法務検索は現在利用できません。" } };
      }
      try {
        await options.slack.post("views.open", {
          trigger_id: triggerId, view: buildLegalSearchModal(String(body.text ?? ""))
        });
        return { status: 200, body: "" };
      } catch (error) {
        log(`slack-intake: search views.open failed: ${error instanceof Error ? error.message : String(error)}`);
        return { status: 200, body: { response_type: "ephemeral", text: "検索フォームを開けませんでした。時間をおいて再度お試しください。" } };
      }
    }
    if (!LEGAL_REQUEST_COMMANDS.has(command)) {
      return { status: 200, body: { response_type: "ephemeral", text: `未対応のコマンドです: ${command}` } };
    }
    try {
      await openModal(triggerId);
      return { status: 200, body: "" };
    } catch (error) {
      log(`slack-intake: views.open failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: { response_type: "ephemeral", text: "依頼フォームを開けませんでした。時間をおいて再度お試しください。" } };
    }
  }

  // 契約チェックエンジンで1候補分の表示データを組む（用途未選択＝契約状況のみ表示）。
  async function searchOne(repo: ContractCheckRepository, vendor: VendorCandidate) {
    const docs = await repo.findVendorDocuments(vendor.id);
    const masterContracts = buildMasterContractSummary(docs);
    const purposeResult = buildPurposeResult({}, masterContracts, findPurpose(""));
    return {
      counterparty: {
        vendorId: vendor.id, vendorCode: vendor.vendorCode ?? "",
        vendorName: vendor.vendorName ?? "", entityType: vendor.entityType ?? ""
      },
      masterContracts,
      licenseConditions: buildLicenseConditions(docs),
      publicationConditions: buildPublicationConditions(docs),
      purposeResult,
      suggestedAction: buildSuggestedAction(purposeResult)
    };
  }

  async function handleSearchSubmission(keyword: string): Promise<SlackIntakeResult> {
    const repo = options.contractCheck;
    if (!repo) {
      return { status: 200, body: { response_action: "update", view: buildErrorView("法務検索は現在利用できません。") } };
    }
    if (!keyword) {
      return { status: 200, body: { response_action: "errors", errors: { keyword_block: "キーワードを入力してください" } } };
    }
    try {
      const candidates = await repo.searchVendors(keyword, 10);
      const outcome: SearchOutcome = { keyword };
      if (candidates.length === 0) {
        outcome.notFound = notFoundResult(null) as unknown as NonNullable<SearchOutcome["notFound"]>;
      } else if (candidates.length === 1) {
        outcome.single = await searchOne(repo, candidates[0]);
      } else {
        outcome.multiple = {
          count: candidates.length,
          results: await Promise.all(candidates.slice(0, 5).map((c) => searchOne(repo, c)))
        };
      }
      const url = backlogSearchUrl(options.backlogHost, options.backlogProjectKey, keyword);
      return { status: 200, body: { response_action: "update", view: buildSearchResultsModal(outcome, url) } };
    } catch (error) {
      log(`slack-intake: search failed: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 200, body: { response_action: "update", view: buildErrorView("検索処理中にエラーが発生しました。") } };
    }
  }

  // ── 16-3c: 依頼モーダルの動的再構築（views.update） ─────────────────
  async function rebuildRequestModal(p: {
    user?: { id?: string };
    view?: { id?: string; hash?: string; private_metadata?: string; state?: { values?: unknown } };
    actions?: BlockAction[];
  }): Promise<void> {
    const action = p.actions?.[0];
    const viewId = p.view?.id;
    if (!action || !viewId) return;
    const slackUserId = String(p.user?.id ?? "");
    const state = (p.view?.state?.values ?? {}) as Record<string, Record<string, { selected_option?: { value?: string } | null }>>;
    const currentType =
      state.request_type_block?.request_type_input?.selected_option?.value || "legal_consult";

    let liCount = 1;
    if (action.action_id === LINE_ITEM_ADD_ACTION_ID || action.action_id === LINE_ITEM_REMOVE_ACTION_ID) {
      try {
        const meta = JSON.parse(p.view?.private_metadata || "{}") as { li_count?: unknown };
        liCount = Number(meta.li_count) || 1;
      } catch { liCount = 1; }
      liCount += action.action_id === LINE_ITEM_ADD_ACTION_ID ? 1 : -1;
      liCount = Math.max(1, Math.min(liCount, LINE_ITEM_MAX));
    }
    const selectedType = action.action_id === REQUEST_TYPE_ACTION_ID
      ? (action.selected_option?.value || "legal_consult")
      : currentType;

    const candidates = await candidatesFor(slackUserId, selectedType);
    try {
      await options.slack.post("views.update", {
        view_id: viewId,
        ...(p.view?.hash ? { hash: p.view.hash } : {}),
        view: buildLegalRequestModal({
          selectedType, candidates, liCount,
          uploadPageUrl: options.uploadPageUrl, vendorSearchUrl: options.vendorSearchUrl
        })
      });
    } catch (error) {
      log(`slack-intake: request modal views.update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── 16-3c: 納期変更依頼（新規作業課題を起こさず、承認用課題を起票して記録） ──
  async function handleDeadlineChange(slackUserId: string, s: LegalRequestSubmission): Promise<SlackIntakeResult> {
    const summary = `納期変更依頼 → ${s.targetIssueKey}`;
    if (!options.backlog) {
      try {
        await options.repository.ledger({
          slackUserId, requestType: DEADLINE_CHANGE_TYPE, summary,
          backlogIssueKey: null, mode: "dry-run", payload: s
        });
      } catch (error) {
        log(`slack-intake: deadline dry-run ledger failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: null, requestTypeLabel: "納期変更依頼",
            summary: `${s.targetIssueKey} の納期を ${s.newDeliveryDate} へ変更`, dryRun: true
          })
        }
      };
    }
    try {
      // V1 worker /api/intake/deadline-change-request と同じ内容の承認用課題。
      // Backlog に「納期変更依頼」課題種別が無い場合は既定種別で起票される（createIssue 側でフォールバック）。
      const created = await options.backlog.createIssue({
        summary: `[納期変更依頼] ${s.targetIssueKey} → ${s.newDeliveryDate}`,
        description:
          `納期変更を申請します。\n\n` +
          `*対象:* ${s.targetIssueKey}\n` +
          `*新しい納期:* ${s.newDeliveryDate}\n` +
          `*変更理由:* ${s.changeReason || "(記載なし)"}\n` +
          `*申請者:* <@${slackUserId}>\n\n` +
          `※ 法務担当者が内容を確認・承認した後に納期変更が実行されます。`,
        issueTypeName: "納期変更依頼"
      });
      await options.repository.recordRequest({
        backlogIssueKey: created.issueKey,
        slackUserId,
        requestType: DEADLINE_CHANGE_TYPE,
        counterparty: null,
        summary,
        // V1 と同じ notes 構造（executed:false）。admin 側の後続処理が判別に使う。
        notes: JSON.stringify({
          type: "deadline_change_request",
          target_issue_key: s.targetIssueKey,
          new_delivery_date: s.newDeliveryDate,
          reason: s.changeReason.slice(0, 500),
          executed: false
        })
      });
      await options.repository.ledger({
        slackUserId, requestType: DEADLINE_CHANGE_TYPE, summary,
        backlogIssueKey: created.issueKey, mode: "live", payload: s
      });
      void dm(slackUserId,
        "✅ *納期変更依頼を受け付けました*\n\n" +
        `*対象:* ${s.targetIssueKey}\n*新しい納期:* ${s.newDeliveryDate}\n*変更理由:* ${s.changeReason}\n` +
        `*依頼課題:* ${created.issueKey}\n` +
        "\n法務担当者が内容を確認後に納期が変更されます。完了時に再度お知らせします。");
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: created.issueKey, requestTypeLabel: "納期変更依頼",
            summary: `${s.targetIssueKey} の納期を ${s.newDeliveryDate} へ変更`, dryRun: false,
            heading: "納期変更依頼を受け付けました",
            noteLines: ["法務担当者が内容を確認後に納期が変更されます。完了時に DM でお知らせします。"]
          })
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`slack-intake: deadline change failed: ${message}`);
      return { status: 200, body: { response_action: "update", view: buildErrorView("納期変更依頼の起票に失敗しました。") } };
    }
  }

  // ── 16-3c: 既存課題への紐付け（新規課題を作らず対象課題へフォーム内容をコメント記録） ──
  async function handleLinkToExisting(slackUserId: string, s: LegalRequestSubmission): Promise<SlackIntakeResult> {
    const childKey = s.targetIssueKeySelect;
    if (!options.backlog) {
      try {
        await options.repository.ledger({
          slackUserId, requestType: s.requestType, summary: s.summary,
          backlogIssueKey: childKey, mode: "dry-run", payload: s
        });
      } catch (error) {
        log(`slack-intake: link dry-run ledger failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: childKey, requestTypeLabel: requestTypeLabel(s.requestType),
            summary: s.summary, dryRun: true, heading: "既存課題に紐付けて受け付けました"
          })
        }
      };
    }
    try {
      const staff = await options.repository.staffBySlackId(slackUserId);
      const lineItemsText = formatLineItemsText(s.requestType, s.lineItems);
      await options.backlog.addComment(childKey,
        `📩 Slack /法務依頼 から追加の依頼が届きました（既存課題への紐付け）。\n\n` +
        `■ 依頼種別: ${requestTypeLabel(s.requestType)}\n` +
        `■ 件名: ${s.summary}\n` +
        `■ 希望納期: ${s.deadline}\n` +
        (s.targetDocNumber ? `■ 対象契約番号: ${s.targetDocNumber}\n` : "") +
        (staff?.email ? `■ 依頼者: ${staff.email}\n` : "") +
        `\n■ 相談・依頼詳細:\n${s.details}\n` +
        (lineItemsText ? `\n${lineItemsText}` : ""));
      await options.repository.ledger({
        slackUserId, requestType: s.requestType, summary: s.summary,
        backlogIssueKey: childKey, mode: "live", payload: { ...s, linkedToExisting: true }
      });
      void dm(slackUserId,
        `⏳ *既存課題への紐付けを受け付けました*: ${childKey}\n` +
        "フォームの入力内容（明細を含む）は対象課題のコメントに記録しました。");
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: childKey, requestTypeLabel: requestTypeLabel(s.requestType),
            summary: s.summary, dryRun: false,
            heading: "既存課題に紐付けて受け付けました",
            noteLines: ["フォームの入力内容 (明細を含む) は対象課題のコメントに記録されます。"]
          })
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`slack-intake: link to existing failed: ${message}`);
      return { status: 200, body: { response_action: "update", view: buildErrorView("既存課題への記録に失敗しました。") } };
    }
  }

  // ── 16-3c: 検収書の契約番号検証＋取引先補完（V1 Phase 28.1 の簡易移植） ──
  //   presence: 各明細の番号（空欄は共通番号）を必須にする。
  //   existence: contract-check リポジトリがあるときのみ実在確認（無ければスキップ）。
  async function validateDeliveryContractNumbers(s: LegalRequestSubmission): Promise<Record<string, string>> {
    const errors: Record<string, string> = {};
    const defaultNo = s.targetDocNumber.trim();
    const items = s.lineItems;
    const effective: Array<{ no: string; block: string }> = [];
    items.forEach((item, i) => {
      const own = String(item.target_doc_number ?? "").trim();
      const no = own || defaultNo;
      const block = own ? `li_${i + 1}_target_doc_number_block` : "target_doc_number_block";
      if (!no) {
        errors[block] = "対象の発注書番号 / 契約書番号を入力してください（明細ごとに違う場合は各明細の「対象契約番号」へ）。";
      }
      effective.push({ no, block });
    });
    if (items.length === 0 && !defaultNo) {
      errors.target_doc_number_block = "対象の発注書番号 / 契約書番号を入力してください（上の候補から選択した場合は不要です）。";
    }
    if (Object.keys(errors).length > 0 || !options.contractCheck) return errors;

    const targets = effective.length > 0 ? effective : [{ no: defaultNo, block: "target_doc_number_block" }];
    const unique = [...new Set(targets.map((t) => t.no))];
    const lookups = new Map<string, Record<string, string> | null>();
    await Promise.all(unique.map(async (no) => {
      try {
        lookups.set(no, await options.contractCheck!.lookupByNumber(no));
      } catch (error) {
        log(`slack-intake: contract lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        lookups.set(no, null);
      }
    }));
    for (const t of targets) {
      if (!lookups.get(t.no)) {
        errors[t.block] = `この番号の契約が見つかりません。番号をご確認ください。 [${t.no}]`;
      }
    }
    if (Object.keys(errors).length === 0) {
      // 取引先を契約から補完（単一契約のときのみ・V1 同様）。
      const vendors = [...new Set(unique.map((no) => lookups.get(no)?.vendor_name).filter(Boolean))];
      if (unique.length === 1) {
        const hit = lookups.get(unique[0])!;
        s.targetDocNumber = hit.document_number || unique[0];
        s.counterparty = hit.vendor_name || s.counterparty;
      } else {
        s.targetDocNumber = `複数 (${unique.length}件 — 明細参照)`;
        s.counterparty = vendors.length === 1 ? String(vendors[0])
          : vendors.length > 1 ? `${vendors[0]} ほか${vendors.length - 1}社` : s.counterparty;
      }
    }
    return errors;
  }

  async function handleInteractivity(payload: unknown): Promise<SlackIntakeResult> {
    const p = (payload ?? {}) as {
      type?: string;
      user?: { id?: string };
      view?: {
        id?: string; hash?: string; callback_id?: string;
        private_metadata?: string; state?: { values?: unknown };
      };
      actions?: BlockAction[];
    };
    if (p.type === "block_actions") {
      if (p.actions?.some((a) => a.action_id === SEARCH_AGAIN_ACTION_ID) && p.view?.id) {
        try {
          await options.slack.post("views.update", { view_id: p.view.id, view: buildLegalSearchModal() });
        } catch (error) {
          log(`slack-intake: views.update failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { status: 200, body: "" };
      }
      // 依頼モーダルの種別変更・明細増減（16-3c）。
      const dynamicIds = new Set([REQUEST_TYPE_ACTION_ID, LINE_ITEM_ADD_ACTION_ID, LINE_ITEM_REMOVE_ACTION_ID]);
      if (p.view?.callback_id === LEGAL_REQUEST_CALLBACK_ID &&
          p.actions?.some((a) => a.action_id && dynamicIds.has(a.action_id))) {
        await rebuildRequestModal(p);
      }
      return { status: 200, body: "" };   // リンクボタン等その他の block_actions は無視
    }
    if (p.type === "view_submission" && p.view?.callback_id === LEGAL_SEARCH_CALLBACK_ID) {
      return handleSearchSubmission(parseSearchKeyword(p.view?.state?.values));
    }
    if (p.type !== "view_submission" || p.view?.callback_id !== LEGAL_REQUEST_CALLBACK_ID) {
      return { status: 200, body: "" };
    }
    const slackUserId = String(p.user?.id ?? "");
    const { submission, errors } = parseLegalRequestSubmission(p.view?.state?.values, p.view?.private_metadata);
    if (Object.keys(errors).length > 0) {
      return { status: 200, body: { response_action: "errors", errors } };
    }

    // 納期変更依頼（16-3c）：新規作業課題は起こさない。
    if (submission.requestType === DEADLINE_CHANGE_TYPE) {
      return handleDeadlineChange(slackUserId, submission);
    }

    // 既存課題への紐付け（16-3c）：候補セレクタで既存課題を選んだとき。
    if ((submission.requestType === "delivery_inspec" || submission.requestType === "license_calc") &&
        submission.targetIssueKeySelect && submission.targetIssueKeySelect !== NEW_ISSUE_VALUE) {
      return handleLinkToExisting(slackUserId, submission);
    }

    // 検収書（新規）：契約番号の必須＋実在チェック（16-3c）。
    if (submission.requestType === "delivery_inspec") {
      const numberErrors = await validateDeliveryContractNumbers(submission);
      if (Object.keys(numberErrors).length > 0) {
        return { status: 200, body: { response_action: "errors", errors: numberErrors } };
      }
    }

    // 計算書（新規）：番号があれば取引先を補完（見つからなくてもブロックしない・V1 同様）。
    if (submission.requestType === "license_calc" && submission.targetDocNumber && options.contractCheck) {
      try {
        const hit = await options.contractCheck.lookupByNumber(submission.targetDocNumber);
        if (hit) {
          submission.targetDocNumber = hit.document_number || submission.targetDocNumber;
          submission.counterparty = hit.vendor_name || submission.counterparty;
        }
      } catch (error) {
        log(`slack-intake: license_calc lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const notesBody = JSON.stringify({
      deadline: submission.deadline, details: submission.details,
      entityType: submission.entityType || null, entityId: submission.entityId || null,
      targetDocNumber: submission.targetDocNumber || null,
      lineItems: submission.lineItems.length ? submission.lineItems : null
    });

    // dry-run（Backlog 未接続）：隔離台帳のみ・共有表は触らない。
    if (!options.backlog) {
      try {
        await options.repository.ledger({
          slackUserId, requestType: submission.requestType, summary: submission.summary,
          backlogIssueKey: null, mode: "dry-run", payload: submission
        });
      } catch (error) {
        log(`slack-intake: dry-run ledger failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: null, requestTypeLabel: requestTypeLabel(submission.requestType),
            summary: submission.summary, dryRun: true
          })
        }
      };
    }

    try {
      const staff = await options.repository.staffBySlackId(slackUserId);
      const created = await options.backlog.createIssue({
        summary: `【${requestTypeLabel(submission.requestType)}】${submission.summary}`,
        description: buildIssueDescription(submission, staff?.email ?? null),
        issueTypeName: backlogIssueTypeFor(submission.requestType)
      });
      await options.repository.recordRequest({
        backlogIssueKey: created.issueKey,
        slackUserId,
        requestType: submission.requestType,
        counterparty: submission.counterparty || null,
        summary: submission.summary,
        notes: notesBody
      });
      await options.repository.ledger({
        slackUserId, requestType: submission.requestType, summary: submission.summary,
        backlogIssueKey: created.issueKey, mode: "live", payload: submission
      });
      // 通知は応答後のベストエフォート（CPU スロットリングで遅延しうるが受付は成立済み）。
      void notify(slackUserId, created.issueKey, submission);
      return {
        status: 200,
        body: {
          response_action: "update",
          view: buildCompletionView({
            issueKey: created.issueKey, requestTypeLabel: requestTypeLabel(submission.requestType),
            summary: submission.summary, dryRun: false
          })
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`slack-intake: submission failed: ${message}`);
      const friendly = (error as { code?: string })?.code === "42501"
        ? "書込権限が未設定です（管理者にお問い合わせください）。"
        : "処理中にエラーが発生しました。";
      return { status: 200, body: { response_action: "update", view: buildErrorView(friendly) } };
    }
  }

  return { handleCommand, handleInteractivity };
}
