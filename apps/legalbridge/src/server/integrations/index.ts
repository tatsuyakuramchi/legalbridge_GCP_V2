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

// 接続確認は読取（getProject）で行う。live でも確認手段は同じで、表示するモードだけが変わる。
class BacklogIntegrationAdapter implements IntegrationAdapter {
  readonly name = "backlog" as const;

  constructor(
    private readonly client: BacklogWebApiClient,
    readonly mode: "readonly" | "live" = "readonly"
  ) {}

  async check() {
    try {
      const project = await this.client.getProject();
      return {
        ok: true,
        detail: `${this.mode === "live" ? "live" : "read-only"} connection: project ${project.projectKey} (${project.name})`
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

// Backlog の**読取**（課題一覧・接続確認）を使える構成か。live は「書けるモード」であって
// 読めなくなるモードではない。ここを readonly 限定にしていたため、live へ上げると依頼画面の
// 課題一覧が黙って空になっていた（§5-3 で発覚）。
export function backlogReadEnabled(mode: "disabled" | "readonly" | "live"): mode is "readonly" | "live" {
  return mode !== "disabled";
}

export function createIntegrationAdapters(): IntegrationAdapter[] {
  const names: IntegrationName[] = ["backlog", "slack", "drive", "cloudsign", "gmail"];
  return names.map((name) => {
    if (
      name === "backlog" &&
      backlogReadEnabled(config.backlogMode) &&
      config.backlogHost &&
      config.backlogProjectKey &&
      config.backlogApiKey
    ) {
      return new BacklogIntegrationAdapter(new BacklogWebApiClient({
        host: config.backlogHost,
        projectKey: config.backlogProjectKey,
        apiKey: config.backlogApiKey
      }), config.backlogMode);
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
