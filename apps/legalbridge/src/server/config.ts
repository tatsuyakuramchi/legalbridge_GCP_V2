export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: process.env.DATABASE_URL ?? null,
  templateSource: "db" as const,
  integrationMode: process.env.INTEGRATION_MODE === "live" ? "live" : "local"
};
