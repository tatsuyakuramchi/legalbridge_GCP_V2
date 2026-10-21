import { DISPATCH_ALLOWLIST_KEY, effectiveAllowlist, readDispatchAllowlist } from "../ops/dispatch-allowlist.js";
import { config } from "../config.js";
import type { Transactable } from "../core/db.js";
import {
  BacklogAdapter, CloudSignAdapter, GmailAdapter, MemoryAdapter, MemoryBacklogReader, MemoryViewOpener, SlackAdapter,
  type BacklogReader, type DispatchAdapter, type SlackViewOpener
} from "./adapters.js";
import { DispatchService } from "./dispatch-service.js";
import type { IntegrationChannel } from "./gate.js";
import { delegatedToken, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "./gmail-auth.js";
import { GoogleLogin } from "./google-login.js";
import { GmailMailSource, MemoryMailSource, type MailSource } from "./mail-source.js";

/**
 * 外部連携の組み立て。
 *
 * 画面の経路（/api/v3）と受信・ジョブの経路（/internal）の両方で同じ
 * ものを使う。片方だけ別に組むと、ゲートの設定が食い違って「画面からは
 * 送れないのにジョブからは送れる」状態が起きる。
 */

const useMemory = () => process.env.DISPATCH_ADAPTERS === "memory";

/**
 * Gmail の送信と読み取り。どちらも送信元（GMAIL_SENDER）のメールボックスの代理で使う
 * （ドメイン全体委任。gmail-auth.ts）。スコープは用途ごとに分ける。
 */
const gmailToken = (scope: string) => delegatedToken({
  sender: config.gmailSender, scope,
  keyFilePath: config.driveKeyFilePath || undefined,
  delegationSa: config.gmailDelegationSa || undefined,
  // 予備系の PC（GCP の外）は、人のログイン（画面の「Google にログイン」か GOOGLE_APPLICATION_CREDENTIALS）で署名を頼む。
  ...(usesHumanLogin() ? { adcToken: () => googleLogin.accessToken() } : {})
});

/**
 * アプリの中で済ませる Google のログイン（google-login.ts）。画面の経路と受信の経路で同じものを使う。
 * メールの署名と Drive のなりすましの元になる。無ければ従来の ADC に戻る。
 */
export const googleLogin = new GoogleLogin({
  clientId: config.googleLoginClientId, clientSecret: config.googleLoginClientSecret, path: config.googleLoginPath
});

/** 人のログインで Google を使う構成か（予備系）。本番（Cloud Run）はメタデータの SA を使うので false。 */
export const usesHumanLogin = () => Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) || googleLogin.configured;

export function buildAdapters(): Partial<Record<IntegrationChannel, DispatchAdapter>> {
  if (useMemory()) {
    return {
      slack: new MemoryAdapter("slack"), gmail: new MemoryAdapter("gmail"),
      cloudsign: new MemoryAdapter("cloudsign"), backlog: new MemoryAdapter("backlog")
    };
  }
  return {
    ...(config.slackBotToken ? { slack: new SlackAdapter(config.slackBotToken) } : {}),
    ...(config.gmailSender
      ? { gmail: new GmailAdapter(gmailToken(GMAIL_SEND_SCOPE), config.gmailSender) } : {}),
    ...(config.cloudSignClientId
      ? { cloudsign: new CloudSignAdapter(config.cloudSignClientId, undefined, undefined,
                                          { autoSend: config.cloudSignAutoSend }) } : {}),
    ...(config.backlogHost && config.backlogApiKey && config.backlogProjectId
      ? { backlog: new BacklogAdapter(config.backlogHost, config.backlogApiKey, config.backlogProjectId) }
      : {})
  };
}

/** Slack のモーダルを開く口。トークンが無ければ null（コマンドは文字だけで返す）。 */
export function buildSlackViews(): SlackViewOpener | null {
  if (useMemory()) return new MemoryViewOpener();
  return config.slackBotToken ? new SlackAdapter(config.slackBotToken) : null;
}

/** いま効いている許可リスト（設定 → 無ければ .env）。 */
export async function currentAllowlist(database: Transactable): Promise<{ allowlist: string[]; source: "env" | "list" | "open" }> {
  try {
    const r = await database.query("SELECT value FROM settings WHERE key = $1", [DISPATCH_ALLOWLIST_KEY]);
    return effectiveAllowlist(readDispatchAllowlist((r.rows[0] as { value?: unknown } | undefined)?.value), config.dispatchAllowlist);
  } catch {
    return { allowlist: config.dispatchAllowlist, source: "env" };
  }
}

export function buildDispatch(
  database: Transactable,
  adapters: Partial<Record<IntegrationChannel, DispatchAdapter>> = buildAdapters()
): DispatchService {
  return new DispatchService(database, adapters, async (channel) => ({
    mode: config.integrationModes[channel],
    adapterConfigured: Boolean(adapters[channel]?.configured),
    readOnly: config.readOnly,
    // 許可リストは設定の画面で変えられる（無ければ .env）。送るたびに読む（上げ直し不要）。
    allowlist: (await currentAllowlist(database)).allowlist
  }));
}

/** 受信メールの取得口。ラベル未設定なら作らない（ジョブが理由を返して終わる）。 */
export function buildMailSource(): MailSource | null {
  if (useMemory()) return new MemoryMailSource([]);
  if (!config.gmailIntakeLabel) return null;
  return new GmailMailSource(gmailToken(GMAIL_READ_SCOPE), config.gmailIntakeLabel);
}

/**
 * Backlog を読む口（受付箱の取得）。接続情報が無ければ作らない（ジョブが理由を返して終わる）。
 * 送信の段階（BACKLOG_MODE）はジョブ側で見る。
 */
export function buildBacklogReader(): BacklogReader | null {
  if (useMemory()) return new MemoryBacklogReader([]);
  if (!(config.backlogHost && config.backlogApiKey && config.backlogProjectId)) return null;
  return new BacklogAdapter(config.backlogHost, config.backlogApiKey, config.backlogProjectId);
}
