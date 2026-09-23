import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Cloudflare Access のログインを確かめる。
 *
 * ローカル版を Cloudflare Tunnel で社外に出すとき、手前の Access が Google や
 * メールの確認コードでログインさせ、通った人のリクエストに署名付きのトークン
 * （Cf-Access-Jwt-Assertion ヘッダ、RS256 の JWT）を付けて渡してくる。
 *
 * メールのヘッダ（Cf-Access-Authenticated-User-Email）だけを信じると、トンネルを
 * 通らずにアプリへ直接届いたリクエストが好きなメールを名乗れる。だから必ず
 * トークンを検証する：
 *   ・署名が Access のチームの公開鍵（/cdn-cgi/access/certs）で正しいこと
 *   ・宛先（aud）がこのアプリの Application Audience（AUD タグ）を含むこと
 *   ・発行元（iss）がチームのドメインであること
 *   ・期限（exp）が切れていないこと
 * 通ったらトークンの email を返す。どれか外れたら例外（呼ぶ側が 401 にする）。
 *
 * 公開鍵は 1 時間持ち回す。知らない鍵 ID が来たら 1 回だけ取り直す
 * （Cloudflare は鍵を定期的に入れ替える）。
 */

export interface AccessSettings {
  /** チームのドメイン。例: arclight-lb.cloudflareaccess.com（https:// は付けても付けなくてもよい） */
  teamDomain: string;
  /** Access のアプリの Application Audience（AUD）タグ。 */
  audience: string;
}

type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string };
type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class AccessTokenError extends Error {}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const teamOrigin = (teamDomain: string) =>
  `https://${teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private readonly origin: string;

  constructor(
    private readonly settings: AccessSettings,
    private readonly fetcher: Fetcher = (url) => fetch(url),
    private readonly now: () => number = () => Date.now()
  ) {
    if (!settings.teamDomain.trim() || !settings.audience.trim()) {
      throw new Error("AUTH_MODE=cloudflare には CF_ACCESS_TEAM_DOMAIN と CF_ACCESS_AUD が要ります");
    }
    this.origin = teamOrigin(settings.teamDomain);
  }

  private async loadKeys(): Promise<void> {
    const res = await this.fetcher(`${this.origin}/cdn-cgi/access/certs`);
    if (!res.ok) throw new AccessTokenError(`Access の公開鍵を取れません（${res.status}）`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || !jwk.kid) continue;
      next.set(jwk.kid, createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }));
    }
    if (!next.size) throw new AccessTokenError("Access の公開鍵が空です");
    this.keys = next;
    this.fetchedAt = this.now();
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const stale = this.now() - this.fetchedAt > 60 * 60 * 1000;
    if (stale || !this.keys.size) await this.loadKeys();
    let key = this.keys.get(kid);
    if (!key && !stale) { await this.loadKeys(); key = this.keys.get(kid); }
    if (!key) throw new AccessTokenError("知らない鍵で署名されたトークンです");
    return key;
  }

  /** トークンを確かめて、ログインした人のメールを返す（小文字）。 */
  async verify(token: string): Promise<string> {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) throw new AccessTokenError("トークンの形が正しくありません");
    const [h, p, s] = parts;
    let header: { alg?: string; kid?: string };
    let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
    try {
      header = JSON.parse(b64url(h).toString("utf8"));
      payload = JSON.parse(b64url(p).toString("utf8"));
    } catch { throw new AccessTokenError("トークンを読めません"); }
    if (header.alg !== "RS256" || !header.kid) throw new AccessTokenError("署名方式が RS256 ではありません");

    const key = await this.keyFor(header.kid);
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64url(s));
    if (!ok) throw new AccessTokenError("署名が正しくありません");

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.settings.audience.trim())) throw new AccessTokenError("このアプリ宛てのトークンではありません");
    if (payload.iss !== this.origin) throw new AccessTokenError("発行元が違います");
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < nowSec - 30) throw new AccessTokenError("トークンの期限が切れています");
    if (typeof payload.nbf === "number" && payload.nbf > nowSec + 30) throw new AccessTokenError("トークンがまだ有効になっていません");
    const email = String(payload.email ?? "").trim().toLowerCase();
    if (!email) throw new AccessTokenError("トークンにメールがありません");
    return email;
  }
}

/** リクエストからトークンを取る。ヘッダが無ければ Access のクッキー（CF_Authorization）。 */
export function accessTokenOf(header: string | undefined, cookie: string | undefined): string {
  if (header && header.trim()) return header.trim();
  const m = String(cookie ?? "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}
