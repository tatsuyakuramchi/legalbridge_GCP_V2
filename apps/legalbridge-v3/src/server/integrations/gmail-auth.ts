import { GoogleAuth } from "google-auth-library";

/**
 * Gmail を送信元（GMAIL_SENDER）のメールボックスの代理で使うためのトークン。
 *
 * Gmail API はサービスアカウント自身としては送れない。Workspace のドメイン全体委任で
 * 「このサービスアカウントは sender として gmail.send してよい」と許し、sub=sender の
 * JWT を交換してトークンを得る（V1 の worker と同じ仕組み）。
 *
 *   - 鍵ファイル（GOOGLE_SERVICE_ACCOUNT_KEY_PATH）があれば、それで署名する。
 *   - 無ければ鍵なし：実行中のサービスアカウント（または GMAIL_DELEGATION_SA）の
 *     IAM Credentials signJwt で署名し、JWT-bearer で交換する。Cloud Run で鍵を持たない構成でも動く。
 *     要るもの：署名する SA に対する roles/iam.serviceAccountTokenCreator と、
 *     その SA の client_id への Workspace のドメイン全体委任（スコープ）。
 *   - GCP の外（予備系の PC。メタデータが無い）では、人のログイン（ADC。adcToken）で signJwt を
 *     呼ぶ。署名する SA は GMAIL_DELEGATION_SA で必ず指定し、ログインした人にその SA の
 *     Token Creator が要る。組織ポリシーで SA の鍵が作れない環境向け（infra/local）。
 *
 * スコープは用途ごとに分けて求める。委任に無いスコープを混ぜると交換そのものが断られる
 * （送信だけ委任してある SA で読み取りまで求めると、送信も止まる）。
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export interface DelegationOptions {
  sender: string;
  scope: string;
  keyFilePath?: string;
  /** 署名に使う SA。空なら実行中の SA。 */
  delegationSa?: string;
  /**
   * GCP の外で signJwt を呼ぶためのトークン（人のログイン＝ADC）。渡すとメタデータを見ない。
   * delegationSa が要る（実行中の SA が無いので）。
   */
  adcToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default";

export function delegatedToken(options: DelegationOptions): () => Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  let cached = { token: "", until: 0 };

  return async () => {
    if (!options.sender) throw new Error("GMAIL_SENDER（送信元のメールアドレス）が未設定です");
    if (cached.token && now() < cached.until) return cached.token;

    if (options.keyFilePath) {
      const auth = new GoogleAuth({
        keyFile: options.keyFilePath, scopes: [options.scope],
        clientOptions: { subject: options.sender }
      });
      const token = (await (await auth.getClient()).getAccessToken()).token;
      if (!token) throw new Error("Gmail のアクセストークンを取得できませんでした（鍵ファイル）");
      cached = { token, until: now() + 50 * 60 * 1000 };
      return token;
    }

    const meta = async (path: string) => {
      const r = await fetchImpl(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
      if (!r.ok) throw new Error(`メタデータを読めませんでした（${path}: ${r.status}）`);
      return r.text();
    };
    let signer: string, access: string;
    if (options.adcToken) {
      signer = options.delegationSa?.trim() ?? "";
      if (!signer) throw new Error("GCP の外で Gmail を使うには GMAIL_DELEGATION_SA（署名に使う SA）が要ります");
      access = await options.adcToken();
    } else {
      signer = options.delegationSa?.trim() || (await meta("email")).trim();
      access = JSON.parse(await meta("token")).access_token as string;
    }
    const iat = Math.floor(now() / 1000);
    const payload = JSON.stringify({
      iss: signer, sub: options.sender, scope: options.scope,
      aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600
    });
    const signed = await fetchImpl(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(signer)}:signJwt`,
      { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({ payload }) });
    if (!signed.ok) {
      throw new Error(`JWT に署名できませんでした（${signed.status}。${signer} への Token Creator を確認`
        + `${options.adcToken ? "。予備系ならログインした人に付ける" : ""}）：`
        + (await signed.text()).slice(0, 200));
    }
    const assertion = (await signed.json() as { signedJwt?: string }).signedJwt;
    if (!assertion) throw new Error("signJwt の応答に署名がありません");

    const exchanged = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString()
    });
    const body = await exchanged.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
    if (!exchanged.ok || !body.access_token) {
      throw new Error("Gmail の代理トークンを得られませんでした（ドメイン全体委任・スコープ・送信元を確認）："
        + `${body.error ?? exchanged.status} ${body.error_description ?? ""}`.trim());
    }
    cached = { token: body.access_token, until: now() + 50 * 60 * 1000 };
    return body.access_token;
  };
}
