export type IntegrationName = "backlog" | "slack" | "drive" | "cloudsign" | "gmail";

export interface IntegrationAdapter {
  readonly name: IntegrationName;
  readonly mode: "local" | "live";
  check(): Promise<{ ok: boolean; detail: string }>;
}

class LocalIntegrationAdapter implements IntegrationAdapter {
  readonly mode = "local" as const;
  constructor(readonly name: IntegrationName) {}

  async check() {
    return { ok: true, detail: "local mock: external writes are disabled" };
  }
}

export function createIntegrationAdapters(): IntegrationAdapter[] {
  const names: IntegrationName[] = ["backlog", "slack", "drive", "cloudsign", "gmail"];
  return names.map((name) => new LocalIntegrationAdapter(name));
}

