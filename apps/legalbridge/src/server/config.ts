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
  databaseAccessMode:
    process.env.DB_ACCESS_MODE === "readwrite" ? "readwrite" as const : "readonly" as const,
  writeFeaturesEnabled: process.env.WRITE_FEATURES_ENABLED === "true",
  writeScopes: new Set(
    String(process.env.WRITE_SCOPES ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean)
  ),
  requireDatabase: process.env.REQUIRE_DATABASE === "true",
  auth: {
    mode: process.env.AUTH_MODE === "iap" ? "iap" as const : "disabled" as const,
    adminEmails: emailSet(process.env.AUTH_ADMIN_EMAILS),
    legalEmails: emailSet(process.env.AUTH_LEGAL_EMAILS),
    requesterDomains: emailSet(process.env.AUTH_REQUESTER_DOMAINS)
  },
  googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID ?? "",
  slackNotificationHistoryEnabled:
    process.env.SLACK_NOTIFICATION_HISTORY_ENABLED === "true",
  slackNotificationApprovalsEnabled:
    process.env.SLACK_NOTIFICATION_APPROVALS_ENABLED === "true",
  slackDryRunUserMap:
    process.env.SLACK_DRY_RUN_USER_MAP ?? "",
  slackDeliveryMode:
    process.env.SLACK_DELIVERY_MODE === "live" ? "live" as const : "disabled" as const,
  backlogMode: backlogMode(process.env.BACKLOG_MODE),
  backlogHost: process.env.BACKLOG_HOST ?? "",
  backlogProjectKey: process.env.BACKLOG_PROJECT_KEY ?? "",
  backlogApiKey: process.env.BACKLOG_API_KEY ?? "",
  templateSource: "db" as const,
  integrationMode: process.env.INTEGRATION_MODE === "live"
    ? "live" as const
    : "local" as const
};
