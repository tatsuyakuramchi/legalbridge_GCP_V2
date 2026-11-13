import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import { useDebounced } from "./ListTools.js";

/**
 * 文書の無い契約に文書を付ける（ポップアップ。画面は切り替えない。「文書を作る」だけ文書の画面へ進む）。
 *
 *   ① 作成済みの文書（外で作った PDF など）を上げて登録  … POST /documents/import（agreementId・番号は契約番号と同じ）
 *   ② システムで作った文書をこの契約に繋ぐ              … GET /documents?partyId=&q= → POST /links/document/:id/agreement
 *   ③ この契約の条件明細で文書を作る                    … 文書の画面（作成）へ。条件を選んだ状態で開く
 */

export interface AttachTarget {
  id: number; agreementNo: string | null; title: string;
  kind: string; domain: string | null; partyId: number;
  conditions: Array<{ id: number; conditionNo: string | null; name: string }>;
}

type Mode = "upload" | "link" | "compose";

const KINDS = ["出版等利用許諾条件書", "個別利用許諾条件書", "利用許諾契約書", "業務委託契約書", "業務委託・利用許諾契約書",
  "覚書", "発注書", "秘密保持契約書", "売買契約書", "念書", "通知書", "その他"];

function defaultKind(t: AttachTarget): string {
  if (t.kind === "supplement" || t.kind === "standalone") {
    if (t.domain === "license") return /出版/.test(t.title) || t.conditions.length > 0 ? "出版等利用許諾条件書" : "個別利用許諾条件書";
    return t.kind === "supplement" ? "覚書" : t.domain === "service" ? "業務委託契約書" : "覚書";
  }
  if (t.kind === "master") {
    return ({ service: "業務委託契約書", license: "利用許諾契約書", hybrid: "業務委託・利用許諾契約書", sale: "売買契約書" } as Record<string, string>)[t.domain ?? ""] ?? "覚書";
  }
  return /秘密保持|NDA/i.test(t.title) ? "秘密保持契約書" : "覚書";
}

interface DocHit {
  id: number; documentNo: string | null; status: string; title: string | null; templateLabel: string | null;
  imported: boolean; agreementId: number | null; counterparty: string | null; issuedAt: string | null;
  conditions: Array<{ id: number; conditionNo: string | null }>;
}
const STATUS: Record<string, string> = { draft: "下書き", issued: "決定済み", superseded: "差し替え済み", void: "無効" };

export function AttachDocDialog({ target, onCompose, onOpenAgreement, onDone, onClose }: {
  target: AttachTarget;
  /** 文書の画面（作成）へ。無ければ③を出さない。 */
  onCompose?: (conditionIds: number[]) => void;
  /** 契約の画面（締結日・期間など）へ。 */
  onOpenAgreement?: () => void;
  onDone: (msg: string) => void; onClose: () => void;
}) {
  const no = target.agreementNo ?? `契約 #${target.id}`;
  const [mode, setMode] = useState<Mode>("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ① 上げる
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState(() => defaultKind(target));
  const [title, setTitle] = useState(target.title);
  const [signedOn, setSignedOn] = useState("");
  const [sameNo, setSameNo] = useState(true);
  const [withConds, setWithConds] = useState(true);

  // ② 繋ぐ
  const [q, setQ] = useState("");
  const query = useDebounced(q, 250);
  const [hits, setHits] = useState<DocHit[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    if (mode !== "link") return;
    let alive = true;
    const qs = new URLSearchParams({ partyId: String(target.partyId) });
    if (query.trim()) qs.set("q", query.trim());
    api.get<{ documents: DocHit[] }>(`/documents?${qs}`)
      .then((r) => { if (alive) setHits(r.documents.filter((d) => d.status !== "void" && d.status !== "superseded").slice(0, 40)); })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [mode, target.partyId, query]);

  async function go(work: () => Promise<string>) {
    setBusy(true); setError(null);
    try { onDone(await work()); onClose(); } catch (e) { setError((e as ApiError).message); } finally { setBusy(false); }
  }
  const upload = () => go(async () => {
    if (!file) throw new ApiError(400, "ファイルを選んでください", "VALIDATION");
    const params = new URLSearchParams({
      title: title.trim() || target.title, documentKind: kind, agreementId: String(target.id),
      filename: file.name, inbound: "0", sameNoAsAgreement: sameNo ? "1" : "0"
    });
    if (signedOn) params.set("receivedOn", signedOn);
    if (withConds && target.conditions.length) params.set("conditionIds", target.conditions.map((c) => c.id).join(","));
    const doc = await api.postRaw<{ id: number; documentNo: string }>(`/documents/import?${params}`, file, file.type || "application/pdf");
    return `${no} に ${doc.documentNo}（${kind}）を登録しました`;
  });
  const link = () => go(async () => {
    const d = hits?.find((x) => x.id === picked);
    if (!d) throw new ApiError(400, "繋ぐ文書を選んでください", "VALIDATION");
    await api.post(`/links/document/${d.id}/agreement`, { targetId: target.id });
    return `${d.documentNo ?? `文書 #${d.id}`} を ${no} に繋ぎました`;
  });

  const tabs: Array<[Mode, string]> = [["upload", "作成済みの文書を上げる"], ["link", "システムの文書を繋ぐ"]];
  if (onCompose) tabs.push(["compose", "文書を作る"]);

  return (
    <Modal title={`${no} に文書を付ける`} onClose={onClose} wide>
      <div className="stack" style={{ gap: 10 }}>
        <div className="faint">{target.title}</div>
        <div className="chips" role="tablist" aria-label="文書の付け方">
          {tabs.map(([m, label]) => (
            <button key={m} className="chip" role="tab" aria-pressed={mode === m} onClick={() => { setMode(m); setError(null); }}>{label}</button>
          ))}
        </div>

        {mode === "upload" && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">外で作った文書（Word から作った PDF・相手から届いた紙のスキャンなど）を上げて、この契約の文書として登録します。</div>
            <div className="grid4">
              <label className="fld"><span>ファイル <em>必須</em></span>
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
              <label className="fld"><span>文書の種類</span>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select></label>
              <label className="fld"><span>件名</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className="fld"><span>締結日・受領日</span>
                <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
                <small>空なら日付なしで登録</small></label>
            </div>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={sameNo} onChange={(e) => setSameNo(e.target.checked)} />
              <span>文書番号は契約番号と同じ（<span className="code">{target.agreementNo ?? "—"}</span>）</span>
            </label>
            {!sameNo && <small className="faint">外さなければ、種類ごとの番号（ARC-MOU-… など）を新しく取ります</small>}
            {target.conditions.length > 0 && (
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={withConds} onChange={(e) => setWithConds(e.target.checked)} />
                <span>この契約の条件明細 {target.conditions.length} 本をこの文書につなぐ（{target.conditions.map((c) => c.conditionNo ?? c.name).join("・")}）</span>
              </label>
            )}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
              <button className="btn primary" disabled={busy || !file} onClick={() => void upload()}>{busy ? "登録しています…" : "上げて登録する"}</button>
            </div>
          </div>
        )}

        {mode === "link" && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">このシステムで作った文書（または取り込み済みの文書）を探して、この契約に繋ぎます。ほかの契約に繋がっていれば付け替えます。</div>
            <input className="inline-input" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="文書番号・件名・条件番号・作品" aria-label="文書を探す" style={{ width: "100%" }} />
            <div className="ct-pick">
              {!hits && !error && <div className="faint" style={{ padding: 8 }}>読み込み中…</div>}
              {hits && !hits.length && <div className="faint" style={{ padding: 8 }}>見つかりません。</div>}
              {hits?.map((d) => {
                const here = d.agreementId === target.id;
                return (
                  <label key={d.id} className={`ct-pick-row${here ? " off" : ""}${picked === d.id ? " on" : ""}`}>
                    <input type="radio" name="doc" disabled={here} checked={picked === d.id} onChange={() => setPicked(d.id)} />
                    <span className="ct-pick-main">
                      <span className="ct-line">
                        <span className="tag">{d.imported ? "取込" : d.templateLabel ?? "文書"}</span>
                        <span className="code">{d.documentNo ?? "（番号なし）"}</span>
                        <span>{d.title}</span>
                        <span className="faint" style={{ marginLeft: "auto" }}>{STATUS[d.status] ?? d.status}</span>
                      </span>
                      <span className="faint">{[d.issuedAt?.slice(0, 10), d.conditions.map((c) => c.conditionNo).filter(Boolean).join("・"),
                        here ? "この契約に繋がっています" : d.agreementId ? "ほかの契約に繋がっています（付け替え）" : "契約に繋がっていません"].filter(Boolean).join("・")}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
              <button className="btn primary" disabled={busy || picked === null} onClick={() => void link()}>{busy ? "繋いでいます…" : "この契約に繋ぐ"}</button>
            </div>
          </div>
        )}

        {mode === "compose" && onCompose && (
          <div className="stack" style={{ gap: 8 }}>
            {target.conditions.length > 0 ? (
              <>
                <div className="faint">この契約の条件明細を選んだ状態で、文書の作成画面を開きます。ひな形（出版等利用許諾条件書・作品ごとに番号 など）はそこで選びます。決定すると、この契約の文書になります。</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {target.conditions.map((c) => <li key={c.id}><span className="code">{c.conditionNo}</span> {c.name}</li>)}
                </ul>
              </>
            ) : <div className="note warn">この契約には条件明細が載っていません。先に「＋ 条件を追加」で載せてから作ってください。</div>}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button className="btn" onClick={onClose}>やめる</button>
              <button className="btn primary" disabled={!target.conditions.length}
                      onClick={() => { onClose(); onCompose(target.conditions.map((c) => c.id)); }}>文書の作成画面へ</button>
            </div>
          </div>
        )}

        {error && <div className="alert">{error}</div>}
        {onOpenAgreement && (
          <button className="linky" style={{ alignSelf: "flex-start" }} onClick={() => { onClose(); onOpenAgreement(); }}>
            契約の画面を開く（締結日・期間など）</button>
        )}
      </div>
    </Modal>
  );
}
