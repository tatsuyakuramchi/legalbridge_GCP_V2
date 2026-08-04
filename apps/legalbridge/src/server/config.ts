function emailSet(value: string | undefined) {
  return new Set(String(value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function backlogMode(value: string | undefined) {
  return value === "readonly" || value === "live" ? value : "disabled" as const;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? null,
  databaseHost: process.env.DB_HOST ?? null,
  databasePort: Number(process.env.DB_PORT ?? 5432),
  databaseName: process.env.DB_NAME ?? null,
  databaseUser: process.env.DB_USER ?? null,
  databasePassword: process.env.DB_PASSWORD ?? null,
  outboundDatabaseHost: process.env.OUTBOUND_DB_HOST ?? null,
  outboundDatabasePort: Number(process.env.OUTBOUND_DB_PORT ?? 5432),
  outboundDatabaseName: process.env.OUTBOUND_DB_NAME ?? null,
  outboundDatabaseUser: process.env.OUTBOUND_DB_USER ?? null,
  outboundDatabasePassword: process.env.OUTBOUND_DB_PASSWORD ?? null,
  databaseAccessMode:
    process.env.DB_ACCESS_MODE === "readwrite" ? "readwrite" as const : "readonly" as const,
  writeFeaturesEnabled: process.env.WRITE_FEATURES_ENABLED === "true",
  outboundConditionWritesEnabled:
    process.env.OUTBOUND_CONDITION_WRITES_ENABLED === "true",
  contractIntakeWritesEnabled:
    process.env.CONTRACT_INTAKE_WRITES_ENABLED === "true",
  matterWritesEnabled:
    process.env.MATTER_WRITES_ENABLED === "true",
  vendorWritesEnabled:
    process.env.VENDOR_WRITES_ENABLED === "true",
  staffWritesEnabled:
    process.env.STAFF_WRITES_ENABLED === "true",
  workWritesEnabled:
    process.env.WORK_WRITES_ENABLED === "true",
  materialWritesEnabled:
    process.env.MATERIAL_WRITES_ENABLED === "true",
  writeScopes: new Set(
    String(process.env.WRITE_SCOPES ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean)
  ),
  requireDatabase: process.env.REQUIRE_DATABASE === "true",
  auth: {
    mode: process.env.AUTH_MODE === "iap"
      ? "iap" as const
      : process.env.AUTH_MODE === "cloudrun-iam"
        ? "cloudrun-iam" as const
        : "disabled" as const,
    adminEmails: emailSet(process.env.AUTH_ADMIN_EMAILS),
    legalEmails: emailSet(process.env.AUTH_LEGAL_EMAILS),
    requesterDomains: emailSet(process.env.AUTH_REQUESTER_DOMAINS)
  },
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID ?? "",
  googleServiceAccountKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "",
  driveEnvironmentTag: process.env.DRIVE_ENVIRONMENT_TAG ?? "validation",
  slackNotificationHistoryEnabled:
    process.env.SLACK_NOTIFICATION_HISTORY_ENABLED === "true",
  slackNotificationApprovalsEnabled:
    process.env.SLACK_NOTIFICATION_APPROVALS_ENABLED === "true",
  slackDryRunUserMap:
    process.env.SLACK_DRY_RUN_USER_MAP ?? "",
  slackDeliveryMode:
    process.env.SLACK_DELIVERY_MODE === "live" ? "live" as const : "disabled" as const,
  slackBotToken: (process.env.SLACK_BOT_TOKEN ?? "").trim(),
  gmailDeliveryMode:
    process.env.GMAIL_DELIVERY_MODE === "live" ? "live" as const : "disabled" as const,
  gmailSenderEmail: (process.env.GMAIL_SENDER ?? "").trim(),
  gmailServiceAccountKeyPath:
    (process.env.GMAIL_SA_KEY_PATH ?? process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH ?? "").trim(),
  cloudSignMode:
    process.env.CLOUDSIGN_MODE === "live" ? "live" as const : "disabled" as const,
  cloudSignBaseUrl: (process.env.CLOUDSIGN_BASE_URL ?? "https://api.cloudsign.jp").trim(),
  cloudSignClientId: (process.env.CLOUDSIGN_CLIENT_ID ?? "").trim(),
  backlogMode: backlogMode(process.env.BACKLOG_MODE),
  backlogHost: process.env.BACKLOG_HOST ?? "",
  backlogProjectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
  backlogApiKey: process.env.BACKLOG_API_KEY ?? "",
  templateSource: "db" as const,
  integrationMode: process.env.INTEGRATION_MODE === "live"
    ? "live" as const
    : "local" as const
};
