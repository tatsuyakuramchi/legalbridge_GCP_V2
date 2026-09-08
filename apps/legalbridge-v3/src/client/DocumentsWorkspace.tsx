import { useEffect, useMemo, useState } from "react";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import type { ConditionSummary } from "../server/core/model.js";
import { api, ApiError } from "./api.js";

interface TemplateRow {
  id: number; templateKey: string; label: string; category: string | null; numberPrefix: string | null;
}
interface DocumentRow {
  id: number; documentNo: string | null; status: string; templateLabel: string | null;
  title: string | null; counterparty: string | null; conditionCount: number;
  issuedAt: string | null; storageUrl: string | null;
}
interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}
interface PreviewResponse {
  html: string; templateLabel: string;
  missing: Array<{ name: string; label: string }>; derived: string[];
  values: Record<string, unknown>;
}

export function DocumentsWorkspace() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => { void reload(); }, [search]);
  async function reload() {
    try {
      const [t, d, c, i] = await Promise.all([
        api.get<{ templates: TemplateRow[] }>("/document-templates"),
        api.get<{ documents: DocumentRow[] }>(
          `/documents${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`),
        api.get<{ conditions: ConditionSummary[] }>("/conditions"),
        api.get<Integrations>("/integrations")
      ]);
      setTemplates(t.templates);
      setDocuments(d.documents);
      setConditions(c.conditions);
      setIntegrations(i);
      if (!templateKey && t.templates[0]) setTemplateKey(t.templates[0].templateKey);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  const body = useMemo(() => ({
    templateKey, conditionIds: picked, manualInputs: manual
  }), [templateKey, picked, manual]);

  async function runPreview() {
    setError(null); setIssued(null); setBusy(true);
    try {
      setPreview(await api.post<PreviewResponse>("/documents/preview", body));
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 下書きを作ってから発行する。採番は発行時にだけ進む。
  async function issue() {
    setError(null); setBusy(true);
    try {
      const draft = await api.post<{ id: number }>("/documents", body);
      const result = await api.post<{ documentNo: string }>(`/documents/${draft.id}/issue`);
      setIssued(result.documentNo);
      setPreview(null);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // メール送付。止まった場合は理由をそのまま出す（黙って送らないのが一番まずい）。
  async function send(id: number) {
    const recipient = window.prompt("送付先のメールアドレス");
    if (!recipient) return;
    setError(null); setStored(null);
    try {
      const result = await api.post<{ sent: boolean; duplicated?: boolean; gate: { reasons: string[] } }>(
        `/documents/${id}/send`,
        { recipient, body: "文書をお送りします。ご確認ください。", attachPdf: true });
      setStored(result.sent ? `${recipient} へ送付しました`
        : result.duplicated ? "同じ内容をすでに送付済みです"
        : `送付しませんでした：${result.gate.reasons.join("／")}`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  // Drive へ保存する。既存ファイルがあれば中身だけ差し替わり、リンクは変わらない。
  /**
   * 無効化。理由を必ず聞く。行は消えず、発行した記録は残る。
   * 外に出したファイルは取り消せないので、そこも伝える。
   */
  async function voidDocument(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} を無効にします。理由を書いてください。\n` +
      "記録は残ります。すでに送付・保存したファイルは取り消せません。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${id}/void`, { reason });
      setIssued(`${no ?? id} を無効にしました`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** 再発行。元を差し替え済みにして、条件を引き継いだ下書きを作る。 */
  async function reissue(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} を作り直します。理由を書いてください。\n` +
      "元の文書は差し替え済みとして残り、条件を引き継いだ下書きができます。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${id}/reissue`, { reason });
      setIssued(`下書き #${r.id} を作りました。内容を確かめてから発行してください`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function store(id: number) {
    setError(null); setStored(null); setBusy(true);
    try {
      const result = await api.post<{ storageUrl: string; mode: string }>(`/documents/${id}/store`);
      setStored(result.mode === "unchanged" ? "すでに保存済みです"
        : result.mode === "replaced" ? "Drive のファイルを差し替えました（リンクは変わりません）"
        : "Drive に保存しました");
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const ready = Boolean(templateKey) && picked.length > 0 && preview !== null && preview.missing.length === 0;

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>文書</h1>
        <p>文書は条件の出力物。相手先も件名も条件と合意から解決するので、入力するのはそこから決まらないものだけ。</p>
      </header>

      {error && <div className="alert">{error}</div>}
      {issued && <div className="note ok">発行しました：<b className="code">{issued}</b></div>}
      {stored && <div className="note ok">{stored}</div>}
      {integrations && !integrations.drive.documents && (
        <div className="note">Drive 保存は未設定です（<span className="code">GOOGLE_DRIVE_FOLDER_ID</span>）。文書の作成と発行はそのまま使えます。</div>
      )}

      <div className="split">
        <div className="stack">
          <div className="panel">
            <div className="panel-hd"><h2>作成</h2></div>
            <div className="panel-bd stack">
              <label className="field">
                <span>テンプレート</span>
                <select value={templateKey} onChange={(e) => { setTemplateKey(e.target.value); setPreview(null); }}>
                  {templates.map((t) => (
                    <option key={t.templateKey} value={t.templateKey}>{t.label}</option>
                  ))}
                </select>
              </label>

              <div>
                <div className="faint">出力する条件（複数可）</div>
                <div className="picker">
                  {conditions.map((c) => (
                    <label key={c.id} className="pick">
                      <input type="checkbox" checked={picked.includes(c.id)}
                             onChange={(e) => {
                               setPreview(null);
                               setPicked((prev) => e.target.checked
                                 ? [...prev, c.id] : prev.filter((id) => id !== c.id));
                             }} />
                      <span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span>
                      <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              {preview && preview.missing.length > 0 && (
                <div className="stack">
                  <div className="faint">条件から決まらない項目（入力が必要）</div>
                  {preview.missing.map((m) => (
                    <label key={m.name} className="field">
                      <span>{m.label}</span>
                      <input value={manual[m.name] ?? ""}
                             onChange={(e) => setManual((prev) => ({ ...prev, [m.name]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              )}

              <div className="row">
                <button className="btn" onClick={runPreview} disabled={busy || !picked.length}>プレビュー</button>
                <button className="btn primary" onClick={issue} disabled={busy || !ready}>発行する</button>
                {preview && (
                  <span className="faint">
                    {preview.derived.length}項目を条件から自動解決
                    {preview.missing.length > 0 && ` ／ 未入力 ${preview.missing.length}件` }
                  </span>
                )}
              </div>
            </div>
          </div>

          {preview && (
            <div className="panel">
              <div className="panel-hd"><h2>プレビュー</h2><span className="faint">{preview.templateLabel}</span></div>
              <iframe className="preview" title="文書プレビュー" srcDoc={preview.html} />
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-hd">
            <h2>発行済み・下書き</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="文書番号・相手先" label="文書を絞り込む" />
          </div>
          <ListCount shown={documents.length} keyword={search} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr><th>文書番号</th><th>種別</th><th>相手先</th><th className="num">条件</th><th>状態</th><th></th></tr></thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className="code">{d.documentNo ?? "（下書き）"}</td>
                    <td>{d.templateLabel ?? "—"}</td>
                    <td>{d.counterparty ?? "—"}</td>
                    <td className="num">{d.conditionCount}</td>
                    <td><StatusTag kind="document" value={d.status} /></td>
                    <td>
                      {d.status === "issued" && (
                        <span className="row">
                          <a href={`/api/v3/documents/${d.id}/html`} target="_blank" rel="noreferrer">HTML</a>
                          <a href={`/api/v3/documents/${d.id}/pdf`}>PDF</a>
                          {d.storageUrl
                            ? <a href={d.storageUrl} target="_blank" rel="noreferrer">Drive</a>
                            : integrations?.drive.documents
                              ? <button className="btn btn-sm" disabled={busy}
                                        onClick={() => store(d.id)}>Driveに保存</button>
                              : null}
                          {integrations?.channels.some((c) => c.channel === "gmail" && c.mode !== "off") && (
                            <button className="btn btn-sm" disabled={busy}
                                    onClick={() => send(d.id)}>送付</button>
                          )}
                          <button className="btn btn-sm" disabled={busy}
                                  onClick={() => reissue(d.id, d.documentNo)}>作り直す</button>
                          <button className="btn btn-sm" disabled={busy}
                                  onClick={() => voidDocument(d.id, d.documentNo)}>無効にする</button>
                        </span>
                      )}
                      {d.status === "draft" && (
                        <button className="btn btn-sm" disabled={busy}
                                onClick={() => voidDocument(d.id, d.documentNo)}>破棄する</button>
                      )}
                      {d.status === "superseded" && (
                        <span className="faint">差し替え済み</span>
                      )}
                    </td>
                  </tr>
                ))}
                {!documents.length && (
                  <tr><td colSpan={6} className="faint">
                    {search.trim() ? `「${search}」に一致する文書はありません` : "文書がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
