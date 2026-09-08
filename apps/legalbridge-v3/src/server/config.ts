// V3 の実行時設定。V2 と違い、DB は v3 スキーマだけを見る。
const bool = (v: string | undefined, fallback = false) =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export interface Config {
  port: number;
  databaseUrl?: string;
  databaseHost?: string;
  databasePort: number;
  databaseName?: string;
  databaseUser?: string;
  databasePassword?: string;
  /** v3 スキーマ以外を見せない。public への読み書きは V1 のものなので触らない。 */
  databaseSchema: string;
  readOnly: boolean;
  authMode: "disabled" | "iap";
  adminEmails: string[];
  legalEmails: string[];
  requesterDomains: string[];
  /** Drive 保存。フォルダIDが空なら機能ごと無効（未設定で落ちない）。 */
  driveFolderId: string;
  driveKeyFilePath: string;
  driveEnvironmentTag: string;
  driveMatterParentFolderId: string;
  /** 外部送信の段階開放。既定は off（設定し忘れで送らない）。 */
  integrationModes: Record<"slack" | "gmail" | "cloudsign" | "backlog", "off" | "dry_run" | "live">;
  /** 検証中に送ってよい宛先。空なら制限しない。 */
  dispatchAllowlist: string[];
  slackBotToken: string;
  slackSigningSecret: string;
  gmailSender: string;
  /** 取り込む受信メールを絞る Gmail のラベル。空なら取り込みごと無効。 */
  gmailIntakeLabel: string;
  cloudSignClientId: string;
  backlogHost: string;
  backlogApiKey: string;
  backlogProjectId: string;
  /** 内部エンドポイント（Webhook受信）の共有シークレット。 */
  webhookToken: string;
}

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// 送信の段階。設定し忘れたら送らない（off）。
const mode = (v: string | undefined): "off" | "dry_run" | "live" => {
  const normalized = String(v ?? "").trim().toLowerCase();
  return normalized === "live" ? "live" : normalized === "dry_run" ? "dry_run" : "off";
};

export const config: Config = {
  port: int(process.env.PORT, 8081),
  databaseUrl: process.env.DATABASE_URL,
  databaseHost: process.env.DB_HOST,
  databasePort: int(process.env.DB_PORT, 5432),
  databaseName: process.env.DB_NAME,
  databaseUser: process.env.DB_USER,
  databasePassword: process.env.DB_PASSWORD,
  databaseSchema: (process.env.DB_SCHEMA ?? "v3").trim(),
  readOnly: bool(process.env.READ_ONLY, false),
  authMode: process.env.AUTH_MODE === "iap" ? "iap" : "disabled",
  adminEmails: list(process.env.ADMIN_EMAILS),
  legalEmails: list(process.env.LEGAL_EMAILS),
  requesterDomains: list(process.env.REQUESTER_DOMAINS),
  driveFolderId: (process.env.GOOGLE_DRIVE_FOLDER_ID ?? "").trim(),
  driveKeyFilePath: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim(),
  driveEnvironmentTag: (process.env.DRIVE_ENVIRONMENT_TAG ?? "validation").trim(),
  driveMatterParentFolderId: (process.env.DRIVE_MATTER_PARENT_FOLDER_ID ?? "").trim(),
  integrationModes: {
    slack: mode(process.env.SLACK_MODE),
    gmail: mode(process.env.GMAIL_MODE),
    cloudsign: mode(process.env.CLOUDSIGN_MODE),
    backlog: mode(process.env.BACKLOG_MODE)
  },
  dispatchAllowlist: list(process.env.DISPATCH_ALLOWLIST),
  slackBotToken: (process.env.SLACK_BOT_TOKEN ?? "").trim(),
  slackSigningSecret: (process.env.SLACK_SIGNING_SECRET ?? "").trim(),
  gmailSender: (process.env.GMAIL_SENDER ?? "").trim(),
  gmailIntakeLabel: (process.env.GMAIL_INTAKE_LABEL ?? "").trim(),
  cloudSignClientId: (process.env.CLOUDSIGN_CLIENT_ID ?? "").trim(),
  backlogHost: (process.env.BACKLOG_HOST ?? "").trim(),
  backlogApiKey: (process.env.BACKLOG_API_KEY ?? "").trim(),
  backlogProjectId: (process.env.BACKLOG_PROJECT_ID ?? "").trim(),
  webhookToken: (process.env.WEBHOOK_TOKEN ?? "").trim()
};
