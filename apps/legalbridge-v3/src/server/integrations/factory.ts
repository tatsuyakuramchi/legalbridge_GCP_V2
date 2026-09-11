import { GoogleAuth } from "google-auth-library";
import { config } from "../config.js";
import type { Transactable } from "../core/db.js";
import {
  BacklogAdapter, CloudSignAdapter, GmailAdapter, MemoryAdapter, SlackAdapter,
  type DispatchAdapter
} from "./adapters.js";
import { DispatchService } from "./dispatch-service.js";
import type { IntegrationChannel } from "./gate.js";
import { GmailMailSource, MemoryMailSource, type MailSource } from "./mail-source.js";

/**
 * 外部連携の組み立て。
 *
 * 画面の経路（/api/v3）と受信・ジョブの経路（/internal）の両方で同じ
 * ものを使う。片方だけ別に組むと、ゲートの設定が食い違って「画面からは
 * 送れないのにジョブからは送れる」状態が起きる。
 */

const useMemory = () => process.env.DISPATCH_ADAPTERS === "memory";

/** Gmail の送信と読み取り。読み取りは受信箱を丸ごとではなくラベルに絞る。 */
const googleAuth = () => new GoogleAuth({
  ...(config.driveKeyFilePath ? { keyFile: config.driveKeyFilePath } : {}),
  scopes: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly"
  ]
});

const accessToken = (auth: GoogleAuth) => async () => {
  const token = await (await auth.getClient()).getAccessToken();
  if (!token.token) throw new Error("Gmail のアクセストークンを取得できませんでした");
  return token.token;
};

export function buildAdapters(): Partial<Record<IntegrationChannel, DispatchAdapter>> {
  if (useMemory()) {
    return {
      slack: new MemoryAdapter("slack"), gmail: new MemoryAdapter("gmail"),
      cloudsign: new MemoryAdapter("cloudsign"), backlog: new MemoryAdapter("backlog")
    };
  }
  const auth = googleAuth();
  return {
    ...(config.slackBotToken ? { slack: new SlackAdapter(config.slackBotToken) } : {}),
    ...(config.gmailSender
      ? { gmail: new GmailAdapter(accessToken(auth), config.gmailSender) } : {}),
    ...(config.cloudSignClientId
      ? { cloudsign: new CloudSignAdapter(config.cloudSignClientId) } : {}),
    ...(config.backlogHost && config.backlogApiKey && config.backlogProjectId
      ? { backlog: new BacklogAdapter(config.backlogHost, config.backlogApiKey, config.backlogProjectId) }
      : {})
  };
}

export function buildDispatch(
  database: Transactable,
  adapters: Partial<Record<IntegrationChannel, DispatchAdapter>> = buildAdapters()
): DispatchService {
  return new DispatchService(database, adapters, (channel) => ({
    mode: config.integrationModes[channel],
    adapterConfigured: Boolean(adapters[channel]?.configured),
    readOnly: config.readOnly,
    allowlist: config.dispatchAllowlist
  }));
}

/** 受信メールの取得口。ラベル未設定なら作らない（ジョブが理由を返して終わる）。 */
export function buildMailSource(): MailSource | null {
  if (useMemory()) return new MemoryMailSource([]);
  if (!config.gmailIntakeLabel) return null;
  return new GmailMailSource(accessToken(googleAuth()), config.gmailIntakeLabel);
}
