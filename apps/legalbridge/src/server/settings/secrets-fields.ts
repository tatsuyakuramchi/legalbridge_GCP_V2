// 設定画面から投入できる秘密情報の allowlist（Phase 2-5）。
// secretName は cloudbuild-write-test.yaml のデプロイ置換（_*_SECRET / _*_SECRET_NAME）と一致させること。
// ここに無いキーは画面から一切書けない。Google Workspace SA 鍵（JSON・ドメイン全体委任）は
// 影響が大きいため対象外（Cloud Shell からのみ投入）。

export interface SecretFieldDefinition {
  key: SecretKey;
  secretName: string;
  label: string;
  hint: string;
  // 保存時の形式チェック（貼り間違い防止の軽いガード）。
  pattern?: RegExp;
  patternHint?: string;
}

export type SecretKey =
  | "BACKLOG_API_KEY"
  | "SLACK_BOT_TOKEN"
  | "SLACK_SIGNING_SECRET"
  | "CLOUDSIGN_CLIENT_ID"
  | "CLOUDSIGN_WEBHOOK_TOKEN"
  | "BACKLOG_WEBHOOK_TOKEN"
  | "JOBS_TRIGGER_TOKEN"
  | "LB_PORTAL_SECRET";

export const SECRET_FIELDS: SecretFieldDefinition[] = [
  {
    key: "BACKLOG_API_KEY", secretName: "backlog-api-key",
    label: "Backlog APIキー",
    hint: "Backlog の個人設定 > API から発行したキー"
  },
  {
    key: "SLACK_BOT_TOKEN", secretName: "SLACK_BOT_TOKEN",
    label: "Slack Bot トークン",
    hint: "Slack App の OAuth & Permissions にある Bot User OAuth Token",
    pattern: /^xoxb-[A-Za-z0-9-]+$/, patternHint: "xoxb- で始まるトークンを貼り付けてください"
  },
  {
    key: "SLACK_SIGNING_SECRET", secretName: "slack-signing-secret",
    label: "Slack 署名シークレット",
    hint: "Slack App の Basic Information にある Signing Secret",
    pattern: /^[0-9a-f]{16,}$/i, patternHint: "英数字の Signing Secret を貼り付けてください"
  },
  {
    key: "CLOUDSIGN_CLIENT_ID", secretName: "cloudsign-client-id",
    label: "CloudSign クライアントID",
    hint: "CloudSign Web API のクライアントID（UUID形式）",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    patternHint: "UUID 形式のクライアントIDを貼り付けてください"
  },
  {
    key: "CLOUDSIGN_WEBHOOK_TOKEN", secretName: "CLOUDSIGN_WEBHOOK_TOKEN",
    label: "CloudSign Webhook トークン",
    hint: "CloudSign からの Webhook 受信を保護する共有トークン（ローテーション用）"
  },
  {
    key: "BACKLOG_WEBHOOK_TOKEN", secretName: "BACKLOG_WEBHOOK_TOKEN",
    label: "Backlog Webhook トークン",
    hint: "Backlog からの Webhook 受信を保護する共有トークン（ローテーション用・Backlog 側 URL の token= も更新すること)"
  },
  {
    key: "JOBS_TRIGGER_TOKEN", secretName: "JOBS_TRIGGER_TOKEN",
    label: "ジョブ起動トークン",
    hint: "Cloud Scheduler からのジョブ起動を保護する共有トークン（ローテーション用・Scheduler 側ヘッダも更新すること)"
  },
  {
    key: "LB_PORTAL_SECRET", secretName: "lb-portal-secret",
    label: "ポータル連携シークレット",
    hint: "検索ポータル（資料アップロード中継）との共有シークレット。ポータル側 LB_PORTAL_SECRET と同じ値にすること"
  }
];

export const SECRET_KEYS = SECRET_FIELDS.map((field) => field.key);

export function findSecretField(key: string): SecretFieldDefinition | undefined {
  return SECRET_FIELDS.find((field) => field.key === key);
}
