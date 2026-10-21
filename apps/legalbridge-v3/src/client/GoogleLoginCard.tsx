import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";

/**
 * 運用 › 外部連携 の「Google のログイン」（予備系。server/integrations/google-login.ts）。
 *
 * メールの署名と Drive のなりすましに使う人のログインを、gcloud を使わずにここで取る・確かめる・消す。
 * 「Google にログイン」は /auth/google/login へ飛び、許可したら #/ops/integrations?google=ok で戻ってくる。
 */

interface Status {
  configured: boolean;
  source: "app" | "adc" | "none";
  email: string | null;
  obtainedAt: string | null;
  ok?: boolean;
  error?: string | null;
}

const SOURCE_LABEL: Record<Status["source"], string> = {
  app: "この画面でログインしたもの", adc: "gcloud のログイン（keys/adc.json）", none: "ログインなし"
};

export function GoogleLoginCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(() => {
    // 戻ってきたときの知らせ（URL の ?google=ok|error）。
    const q = new URLSearchParams((window.location.hash.split("?")[1] ?? ""));
    const g = q.get("google");
    if (g === "ok") return { kind: "ok", text: `Google にログインしました${q.get("email") ? `（${q.get("email")}）` : ""}。そのまま送れます` };
    if (g === "error") return { kind: "error", text: q.get("msg") ?? "Google のログインに失敗しました" };
    return null;
  });

  const load = async (check = false) => {
    setBusy(true);
    try { setStatus(await api.get<Status>(`/integrations/google${check ? "?check=1" : ""}`)); }
    catch (e) { setNote({ kind: "error", text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  async function logout() {
    if (!window.confirm("この画面で取った Google のログインを消します。メールと Drive は、次にログインするまで使えません。")) return;
    setBusy(true);
    try { setStatus(await api.post<Status>("/integrations/google/logout", {})); setNote({ kind: "ok", text: "ログインを消しました" }); }
    catch (e) { setNote({ kind: "error", text: e instanceof ApiError ? e.message : String(e) }); }
    finally { setBusy(false); }
  }

  if (!status) return null;
  if (!status.configured && status.source === "none") return null; // 本番（Cloud Run）では出さない
  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>Google のログイン（予備系）</h2>
        <span className="faint">メールの署名と Drive の保存に使う人のログイン。組織の再認証ポリシーで切れたらここで取り直す</span>
      </div>
      <div className="panel-bd stack">
        {note && <div className={note.kind === "ok" ? "notice" : "alert"}>{note.text}</div>}
        <dl className="dl">
          <dt>いまの認証</dt>
          <dd>
            {SOURCE_LABEL[status.source]}
            {status.email && <>　<span className="code">{status.email}</span></>}
            {status.obtainedAt && <span className="faint">　{status.obtainedAt.slice(0, 16).replace("T", " ")} にログイン</span>}
          </dd>
          {status.ok !== undefined && (
            <>
              <dt>確認</dt>
              <dd>{status.ok ? <span className="tag ok">使えます</span> : <><span className="tag warn">切れています</span>　<span className="faint">{status.error}</span></>}</dd>
            </>
          )}
        </dl>
        <div className="row">
          {status.configured
            ? <a className="btn primary" href="/auth/google/login">{status.source === "none" ? "Google にログイン" : "Google にログインし直す"}</a>
            : <span className="faint">画面からのログインは未設定（.env の GOOGLE_LOGIN_CLIENT_ID / GOOGLE_LOGIN_CLIENT_SECRET）。gcloud のログインを使っています</span>}
          <button className="btn" onClick={() => void load(true)} disabled={busy || status.source === "none"}>確かめる</button>
          {status.source === "app" && <button className="btn" onClick={() => void logout()} disabled={busy}>ログインを消す</button>}
        </div>
        <div className="faint">
          ログインはブラウザで Google の許可画面が開き、許可するとこの画面に戻ります。gcloud も PowerShell も要りません。
          切れると送るときに「Google のログインが切れています」と出るので、そのときはここで「ログインし直す」。
        </div>
      </div>
    </div>
  );
}
