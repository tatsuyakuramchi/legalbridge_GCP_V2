import { config } from "../config.js";
import { BacklogWebApiClient } from "./backlog-web-api.js";

export type IntegrationName = "backlog" | "slack" | "drive" | "cloudsign" | "gmail";
export type IntegrationMode = "local" | "readonly" | "live";

export interface IntegrationAdapter {
  readonly name: IntegrationName;
  readonly mode: IntegrationMode;
  check(): Promise<{ ok: boolean; detail: string }>;
}

class LocalIntegrationAdapter implements IntegrationAdapter {
  readonly mode = "local" as const;
  constructor(readonly name: IntegrationName) {}

  async check() {
    return { ok: true, detail: "local mock: external writes are disabled" };
  }
}

class BacklogReadOnlyIntegrationAdapter implements IntegrationAdapter {
  readonly name = "backlog" as const;
  readonly mode = "readonly" as const;

  constructor(private readonly client: BacklogWebApiClient) {}

  async check() {
    try {
      const project = await this.client.getProject();
      return {
        ok: true,
        detail: `read-only connection: project ${project.projectKey} (${project.name})`
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Backlog connection failed"
      };
    }
  }
}

class GmailLiveIntegrationAdapter implements IntegrationAdapter {
  readonly name = "gmail" as const;
  readonly mode = "live" as const;
  constructor(private readonly senderEmail: string) {}
  async check() {
    return { ok: true, detail: `live: send-as ${this.senderEmail}` };
  }
}

class CloudSignLiveIntegrationAdapter implements IntegrationAdapter {
  readonly name = "cloudsign" as const;
  readonly mode = "live" as const;
  constructor(private readonly baseUrl: string) {}
  async check() {
    return { ok: true, detail: `live: ${this.baseUrl}` };
  }
}

export function createIntegrationAdapters(): IntegrationAdapter[] {
  const names: IntegrationName[] = ["backlog", "slack", "drive", "cloudsign", "gmail"];
  return names.map((name) => {
    if (
      name === "backlog" &&
      config.backlogMode === "readonly" &&
      config.backlogHost &&
      config.backlogProjectKey &&
      config.backlogApiKey
    ) {
      return new BacklogReadOnlyIntegrationAdapter(new BacklogWebApiClient({
        host: config.backlogHost,
        projectKey: config.backlogProjectKey,
        apiKey: config.backlogApiKey
      }));
    }
    if (name === "gmail" && config.gmailDeliveryMode === "live" && config.gmailSenderEmail) {
      return new GmailLiveIntegrationAdapter(config.gmailSenderEmail);
    }
    if (name === "cloudsign" && config.cloudSignMode === "live" && config.cloudSignClientId) {
      return new CloudSignLiveIntegrationAdapter(config.cloudSignBaseUrl);
    }
    return new LocalIntegrationAdapter(name);
  });
}
