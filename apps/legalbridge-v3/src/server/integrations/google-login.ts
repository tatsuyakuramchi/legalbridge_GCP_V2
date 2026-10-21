import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GoogleAuth, UserRefreshClient, type AuthClient } from "google-auth-library";

/**
 * アプリの中で済ませる Google のログイン（予備系の PC 向け。docs/v3-local-gmail.md「Google にログイン」）。
 *
 * 予備系はメールの署名（IAM Credentials の signJwt）と Drive（SA のなりすまし）に「人のログイン」が要る。
 * これまでは gcloud の ADC（keys/adc.json）を PowerShell 2 つで写していたが、組織の再認証ポリシーで
 * 毎日切れるので手間が大きい。ここでは app 自身が OAuth の認可コードの流れをやる：
 *
 *   運用 › 外部連携 の「Google にログイン」 → /auth/google/login（state を発行して Google へ）
 *   → 許可 → /auth/google/callback（コードをトークンに替えて GOOGLE_LOGIN_PATH に保存）
 *
 * 保存する形は gcloud の ADC と同じ authorized_user の JSON。google-auth-library がそのまま読める。
 * ファイルがあればそれを使い、無ければ従来の ADC（GOOGLE_APPLICATION_CREDENTIALS）に戻る。
 * 切れたときの invalid_rapt / invalid_grant は「ログインし直してください」に言い換える。
 *
 * 必要な準備：GCP の OAuth クライアント（ウェブ アプリケーション）。リダイレクト URI に
 * `<画面の URL>/auth/google/callback` を登録し、ID とシークレットを GOOGLE_LOGIN_CLIENT_ID /
 * GOOGLE_LOGIN_CLIENT_SECRET に入れる。
 */

export const GOOGLE_LOGIN_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  // signJwt と SA のなりすまし（IAM Credentials）に要る。
  "https://www.googleapis.com/auth/cloud-platform"
];

const STATE_TTL_MS = 10 * 60 * 1000;

export interface StoredGoogleLogin {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** 誰のログインか（画面に出す）。 */
  email?: string;
  /** ログインした時刻（ISO）。 */
  obtained_at?: string;
}

export interface GoogleLoginOptions {
  clientId: string;
  clientSecret: string;
  /** 保存先（authorized_user の JSON）。 */
  path: string;
  /** 従来の ADC（GOOGLE_APPLICATION_CREDENTIALS）。無ければ環境変数から。 */
  adcPath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomState?: () => string;
}

export interface GoogleLoginStatus {
  /** OAuth クライアントが設定されているか（無ければ画面にボタンを出さない）。 */
  configured: boolean;
  /** いま使う認証の出どころ。app＝この画面のログイン、adc＝gcloud の ADC、none＝無し。 */
  source: "app" | "adc" | "none";
  email: string | null;
  obtainedAt: string | null;
  /** check=1 のとき：トークンを取り直して生きているか。 */
  ok?: boolean;
  error?: string | null;
}

/** Google の認証エラーを、画面で次の手が分かる言葉にする。 */
export function friendlyGoogleAuthError(error: unknown): Error {
  const raw = describe(error);
  if (/invalid_rapt|reauth/i.test(raw)) {
    return new Error("Google のログインが切れています（組織の再認証ポリシー）。運用 › 外部連携 の「Google にログインし直す」を押してください");
  }
  if (/invalid_grant/i.test(raw)) {
    return new Error("Google のログインが無効になっています（取り消されたか期限切れ）。運用 › 外部連携 の「Google にログインし直す」を押してください");
  }
  return error instanceof Error ? error : new Error(raw);
}

function describe(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.message);
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data) parts.push(typeof data === "string" ? data : JSON.stringify(data));
  if (!parts.length) parts.push(String(error));
  return parts.join(" ");
}

export class GoogleLogin {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomState: () => string;
  private readonly states = new Map<string, number>();
  private cached: { key: string; client: AuthClient } | null = null;

  constructor(private readonly options: GoogleLoginOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.randomState = options.randomState ?? (() => crypto.randomBytes(24).toString("base64url"));
  }

  get configured(): boolean {
    return Boolean(this.options.clientId.trim() && this.options.clientSecret.trim() && this.options.path.trim());
  }

  get path(): string { return this.options.path; }

  private get adcPath(): string {
    return (this.options.adcPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  }

  /** ログインの開始。state を覚えておき、戻ってきたときに照合する。 */
  start(redirectUrl: string): { url: string; state: string } {
    if (!this.configured) throw new Error("Google のログインは設定されていません（GOOGLE_LOGIN_CLIENT_ID / GOOGLE_LOGIN_CLIENT_SECRET）");
    this.sweep();
    const state = this.randomState();
    this.states.set(state, this.now() + STATE_TTL_MS);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.options.clientId.trim(),
      redirect_uri: redirectUrl,
      scope: GOOGLE_LOGIN_SCOPES.join(" "),
      state,
      access_type: "offline",
      // 毎回 refresh_token をもらう（2 回目以降は省かれることがある）。
      prompt: "consent",
      include_granted_scopes: "true"
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`, state };
  }

  /** Google から戻ってきたところ。コードをトークンに替えて保存する。 */
  async finish(input: { code: string; state: string; redirectUrl: string }): Promise<{ email: string | null }> {
    if (!this.configured) throw new Error("Google のログインは設定されていません");
    this.sweep();
    const until = this.states.get(input.state);
    if (!until) throw new Error("ログインの手続きが古いか、別のところから始まっています。もう一度「Google にログイン」から始めてください");
    this.states.delete(input.state);
    const r = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUrl,
        client_id: this.options.clientId.trim(), client_secret: this.options.clientSecret.trim()
      }).toString()
    });
    const body = await r.json().catch(() => ({})) as {
      access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string;
    };
    if (!r.ok || !body.access_token) {
      throw new Error(`Google がトークンを返しませんでした：${body.error ?? r.status} ${body.error_description ?? ""}`.trim());
    }
    if (!body.refresh_token) {
      throw new Error("Google が refresh_token を返しませんでした。Google アカウントの「サードパーティのアクセス」でこのアプリを削除してから、もう一度ログインしてください");
    }
    const email = emailOf(body.id_token) ?? await this.userEmail(body.access_token);
    const stored: StoredGoogleLogin = {
      type: "authorized_user",
      client_id: this.options.clientId.trim(), client_secret: this.options.clientSecret.trim(),
      refresh_token: body.refresh_token,
      ...(email ? { email } : {}),
      obtained_at: new Date(this.now()).toISOString()
    };
    fs.mkdirSync(path.dirname(this.options.path), { recursive: true });
    fs.writeFileSync(this.options.path, JSON.stringify(stored, null, 2), { mode: 0o600 });
    this.cached = null;
    return { email };
  }

  logout(): void {
    try { fs.unlinkSync(this.options.path); } catch { /* 無ければそれでよい */ }
    this.cached = null;
  }

  read(): StoredGoogleLogin | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.options.path, "utf8")) as StoredGoogleLogin;
      return v && v.type === "authorized_user" && v.refresh_token ? v : null;
    } catch { return null; }
  }

  /** この画面のログインがあるか（従来の ADC は数えない）。 */
  hasAppLogin(): boolean { return this.read() !== null; }

  /** 人のログインが何かしらあるか（この画面か、従来の ADC）。 */
  hasAnyLogin(): boolean { return this.hasAppLogin() || Boolean(this.adcPath && fs.existsSync(this.adcPath)); }

  async status(opts: { check?: boolean } = {}): Promise<GoogleLoginStatus> {
    const app = this.read();
    const source: GoogleLoginStatus["source"] = app ? "app" : (this.adcPath && fs.existsSync(this.adcPath)) ? "adc" : "none";
    const base: GoogleLoginStatus = {
      configured: this.configured, source,
      email: app?.email ?? null, obtainedAt: app?.obtained_at ?? null
    };
    if (!opts.check) return base;
    if (source === "none") return { ...base, ok: false, error: "ログインがありません" };
    try {
      await this.accessToken();
      return { ...base, ok: true, error: null };
    } catch (error) {
      return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * なりすまし・signJwt の元になる認証。この画面のログインがあればそれ、無ければ従来の ADC。
   * ファイルが書き換わったら（ログインし直し）作り直す。
   */
  async sourceClient(): Promise<AuthClient> {
    const app = this.read();
    const key = app ? `app:${mtimeOf(this.options.path)}` : this.adcPath ? `adc:${mtimeOf(this.adcPath)}` : "adc:default";
    if (this.cached && this.cached.key === key) return this.cached.client;
    let client: AuthClient;
    if (app) {
      client = new UserRefreshClient({ clientId: app.client_id, clientSecret: app.client_secret, refreshToken: app.refresh_token });
    } else {
      if (this.adcPath && !fs.existsSync(this.adcPath)) {
        throw new Error(this.configured
          ? "Google のログインがありません。運用 › 外部連携 の「Google にログイン」を押してください"
          : `ログインの認証情報（${this.adcPath}）がありません。docker compose run --rm login で取ってください`);
      }
      client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient() as AuthClient;
    }
    this.cached = { key, client };
    return client;
  }

  /** signJwt を呼ぶためのアクセストークン。切れていれば言い換えたエラーを投げる。 */
  async accessToken(): Promise<string> {
    try {
      const client = await this.sourceClient();
      const token = (await client.getAccessToken()).token;
      if (!token) throw new Error("Google のログインからトークンを取れませんでした");
      return token;
    } catch (error) {
      this.cached = null;
      throw friendlyGoogleAuthError(error);
    }
  }

  private async userEmail(accessToken: string): Promise<string | null> {
    try {
      const r = await this.fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
      if (!r.ok) return null;
      const body = await r.json() as { email?: string };
      return body.email ?? null;
    } catch { return null; }
  }

  private sweep() {
    const now = this.now();
    for (const [k, until] of this.states) if (until < now) this.states.delete(k);
  }
}

function emailOf(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email ?? null;
  } catch { return null; }
}

function mtimeOf(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
