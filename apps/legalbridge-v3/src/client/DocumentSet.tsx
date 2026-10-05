import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { DocumentFields, type Candidate, type FormField } from "./DocumentFields.js";
import { SendMany } from "./SendMany.js";
import { useDebounced } from "./ListTools.js";
import { canonicalField, expandShared } from "../server/documents/field-synonyms.js";

/**
 * 文書をまとめて作る（1 つのフォーム）。
 *
 *   スイッチ 1 基本契約（作る／既存を使う／作らない）
 *   スイッチ 2 本体：個別利用許諾条件書・発注書（作る／作らない）
 *   スイッチ 3 追加：著作物を分ける（追加イラスト等）／別の作品（複数のゲーム・出版物）。何枚でも
 *
 * 共通の欄（同じ名前の欄が 2 枚以上にあるもの）は 1 回だけ入れ、各文書には固有の欄だけを出す。
 * 決定はまとめて（/document-sets：基本契約の記録 → 条件の載せ替え → 確かめ → 基本契約書 → 条件書・発注書）。
 * 送付は ①内容確認のメールを 1 通（担当者・取引先）→ ②CloudSign を 1 封筒（締結）。
 */

export interface SetCondition { id: number; conditionNo: string | null; name: string; work: { id: number; title: string } | null }
export interface SetAgreement { id: number; agreementNo: string | null; title: string; status: string; kind: string }
interface Preview { html: string; fields: FormField[]; missing: Array<{ name: string; label: string }>; candidates: Candidate[]; templateLabel?: string }

type Role = "master" | "main" | "extra";
interface DocSpec { uid: string; role: Exclude<Role, "master">; on: boolean; templateKey: string; conditionIds: number[]; reason: "split" | "work" }
interface Issued { role: Role; templateKey: string; id: number; documentNo: string | null }

const uid = () => Math.random().toString(36).slice(2, 9);
const EXTRA_REASON = { split: "著作物を分ける（追加イラスト等）", work: "別の作品（複数のゲーム・出版物）" } as const;

export function DocumentSet({
  domain, matterId, partyId, partyName, masterKey, masterLabel, termsOptions, conditions, agreements,
  channels, isAdmin, onIssued, onOpenDocument, onClose
}: {
  domain: "license" | "service";
  matterId: number | null; partyId: number; partyName: string | null;
  masterKey: string; masterLabel: string;
  /** 本体・追加に使えるひな形（条件書の一覧形式／別紙形式、発注書など）。最初が既定。 */
  termsOptions: Array<{ key: string; label: string }>;
  conditions: SetCondition[];
  agreements: SetAgreement[];
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
  isAdmin: boolean;
  onIssued: () => void;
  onOpenDocument: (id: number) => void;
  onClose: () => void;
}) {
  const masters = agreements.filter((a) => (a.kind === "master" || a.kind === "standalone") && a.status !== "terminated");
  // スイッチ 1：既存の基本契約があれば「既存を使う（基本契約書は作らない）」が既定。
  const [masterMode, setMasterMode] = useState<"create" | "existing" | "none">(masters.length ? "existing" : "create");
  const [existingId, setExistingId] = useState<number | null>(masters[0]?.id ?? null);
  const [masterTitle, setMasterTitle] = useState(domain === "license" ? "利用許諾基本契約" : "業務委託基本契約");
  const defaultKey = termsOptions[0]?.key ?? "";
  const [docs, setDocs] = useState<DocSpec[]>(() => [
    { uid: uid(), role: "main", on: true, templateKey: defaultKey, conditionIds: conditions.map((c) => c.id), reason: "split" }
  ]);
  const [shared, setShared] = useState<Record<string, string>>({});
  const [own, setOwn] = useState<Record<string, Record<string, string>>>({});
  const [previews, setPreviews] = useState<Record<string, Preview | { error: string }>>({});
  const [tab, setTab] = useState<string>("master");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ documents: Issued[]; agreementNo: string | null; error?: string } | null>(null);
  const [sending, setSending] = useState<null | "mail" | "cloudsign">(null);

  const makeMaster = masterMode === "create";
  const active = docs.filter((d) => d.on);
  /** 作る文書（プレビュー・決定の単位）。基本契約書が先。 */
  const plan = useMemo(() => [
    ...(makeMaster ? [{ uid: "master", role: "master" as Role, templateKey: masterKey, conditionIds: [] as number[] }] : []),
    ...active.map((d) => ({ uid: d.uid, role: d.role as Role, templateKey: d.templateKey, conditionIds: d.conditionIds }))
  ], [makeMaster, masterKey, active.map((d) => `${d.uid}:${d.templateKey}:${d.conditionIds.join(",")}`).join("|")]);
  // 共通の欄は組の名前で持ち、文書に渡すときに組のすべての欄の名前へ開く。
  const inputsFor = (u: string) => ({ ...expandShared(shared), ...(own[u] ?? {}) });
  const agreementForPreview = (role: Role, key: string) =>
    role === "master" ? null : masterMode === "existing" && !/terms/.test(key) ? existingId : null;

  // プレビュー（必須の欄・入力欄・本文）。打つたびではなく少し待ってから。
  const inputsJson = useDebounced(JSON.stringify({ shared, own, plan, existingId, masterMode }), 600);
  useEffect(() => {
    let live = true;
    void (async () => {
      const next: Record<string, Preview | { error: string }> = {};
      for (const p of plan) {
        try {
          next[p.uid] = await api.post<Preview>("/documents/preview", {
            templateKey: p.templateKey, conditionIds: p.conditionIds, matterId,
            agreementId: agreementForPreview(p.role, p.templateKey), manualInputs: inputsFor(p.uid)
          });
        } catch (e) { next[p.uid] = { error: e instanceof ApiError ? e.message : String(e) }; }
      }
      if (live) setPreviews(next);
    })();
    return () => { live = false; };
  }, [inputsJson]);

  const ok = (u: string) => { const p = previews[u]; return p && !("error" in p) ? p : null; };
  // 共通の欄：違う種類の文書（基本契約書と条件書など）に同じ名前である欄（計算の欄は除く）。
  // 同じ種類の 2 枚（本体と追加の条件書）は、対象製品名などが文書ごとに違うので共通にしない
  // （追加の文書には「本体と同じ値を入れる」を出す）。
  const sharedNames = useMemo(() => {
    const kinds = new Map<string, Set<string>>();
    for (const p of plan) for (const f of ok(p.uid)?.fields ?? []) {
      if (f.source === "computed") continue;
      const k = canonicalField(f.name);
      if (!kinds.has(k)) kinds.set(k, new Set());
      kinds.get(k)!.add(p.templateKey);
    }
    return new Set([...kinds.entries()].filter(([, ks]) => ks.size >= 2).map(([name]) => name));
  }, [previews, plan]);
  const sharedFields = useMemo(() => {
    const seen = new Set<string>(); const out: FormField[] = [];
    for (const p of plan) for (const f of ok(p.uid)?.fields ?? []) {
      const k = canonicalField(f.name);
      if (sharedNames.has(k) && !seen.has(k)) { seen.add(k); out.push({ ...f, name: k, group: "共通" }); }
    }
    return out;
  }, [sharedNames, previews, plan]);
  const missing = plan.flatMap((p) => (ok(p.uid)?.missing ?? []).map((m) => ({ uid: p.uid, label: m.label })));
  const assigned = new Set(active.flatMap((d) => d.conditionIds));
  const unassigned = conditions.filter((c) => !assigned.has(c.id));
  const docLabel = (role: Role, key: string, i: number) => role === "master" ? masterLabel
    : `${role === "extra" ? `追加 ${i}：` : ""}${termsOptions.find((t) => t.key === key)?.label ?? key}`;

  /** 同じひな形の本体（追加の文書が値を写す元）。 */
  const mainOf = (key: string) => docs.find((d) => d.role === "main" && d.on && d.templateKey === key)?.uid ?? null;
  const setDoc = (u: string, patch: Partial<DocSpec>) => setDocs((ds) => ds.map((d) => d.uid === u ? { ...d, ...patch } : d));
  /** 条件はどれか 1 枚に載せる。別の文書に付けたら、前の文書からは外す。 */
  const toggleCondition = (u: string, id: number, on: boolean) => setDocs((ds) => ds.map((d) =>
    d.uid === u ? { ...d, conditionIds: on ? [...new Set([...d.conditionIds, id])] : d.conditionIds.filter((x) => x !== id) }
      : on ? { ...d, conditionIds: d.conditionIds.filter((x) => x !== id) } : d));

  async function issue() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ agreement: { agreementNo: string | null } | null; documents: Issued[]; error?: string }>("/document-sets", {
        domain, counterpartyId: partyId, matterId,
        master: masterMode === "none" ? null
          : masterMode === "existing" ? { existingAgreementId: existingId }
          : { templateKey: masterKey, title: masterTitle, manualInputs: inputsFor("master") },
        docs: active.map((d) => ({ templateKey: d.templateKey, conditionIds: d.conditionIds, role: d.role, manualInputs: inputsFor(d.uid) }))
      });
      setResult({ documents: r.documents, agreementNo: r.agreement?.agreementNo ?? null, error: r.error });
      onIssued();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (result) {
    const sendable = result.documents.map((d) => ({ id: d.id, documentNo: d.documentNo, counterparty: partyName }));
    return (
      <div className="panel">
        <div className="panel-hd"><h2>まとめて作った文書</h2>
          {result.agreementNo && <span className="tag">基本契約 {result.agreementNo}</span>}
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button></div>
        <div className="panel-bd stack">
          {result.error && <div className="alert">{result.error}</div>}
          {result.documents.map((d, i) => (
            <div key={d.id} className="row" style={{ gap: 8 }}>
              <button className="linky code" onClick={() => onOpenDocument(d.id)}>{d.documentNo ?? `#${d.id}`}</button>
              <span>{docLabel(d.role, d.templateKey, result.documents.slice(0, i).filter((x) => x.role === "extra").length + 1)}</span>
              <span className="tag ok">決定済</span>
            </div>
          ))}
          <div className="stack" style={{ gap: 6 }}>
            <b>送る（{result.documents.length} 枚まとめて）</b>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={!sendable.length} onClick={() => setSending("mail")}>① 内容確認のメールを 1 通で送る</button>
              <button className="btn" disabled={!sendable.length || !isAdmin} onClick={() => setSending("cloudsign")}>② CloudSign を 1 封筒で作る（締結）</button>
            </div>
            <span className="faint">① は当社担当者・事業部の担当者と取引先への内容確認（PDF を全部添付）。確認が取れたら ② で全部を 1 つの封筒にして署名を依頼します。</span>
          </div>
          {sending && (
            <SendMany key={sending} documents={sendable} channels={channels} isAdmin={isAdmin}
                      initialWay={sending} prefillSigners={sending === "cloudsign"} prefillMail={sending === "mail"}
                      onDone={() => { onIssued(); }} onClose={() => setSending(null)} />
          )}
        </div>
      </div>
    );
  }

  const tabs = plan.map((p, i) => ({ ...p, label: docLabel(p.role, p.templateKey, plan.slice(0, i).filter((x) => x.role === "extra").length + 1) }));
  const shown = tabs.find((t) => t.uid === tab) ?? tabs[0];
  const shownPreview = shown ? previews[shown.uid] : null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>文書をまとめて作る</h2>
        <span className="faint">{partyName ?? ""}　共通の欄は 1 回だけ。決定はまとめて、送付はメール 1 通 → CloudSign 1 封筒</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>やめる</button>
      </div>
      <div className="panel-bd stack" style={{ gap: 14 }}>
        {error && <div className="alert" style={{ whiteSpace: "pre-line" }}>{error}</div>}

        {/* スイッチ */}
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <b style={{ minWidth: 150 }}>1. {masterLabel}</b>
            <span className="chips" role="group" aria-label="基本契約">
              <button className="chip" aria-pressed={masterMode === "create"} onClick={() => setMasterMode("create")}>作成する</button>
              {masters.length > 0 && <button className="chip" aria-pressed={masterMode === "existing"} onClick={() => setMasterMode("existing")}>既存を使う（作成しない）</button>}
              <button className="chip" aria-pressed={masterMode === "none"} onClick={() => setMasterMode("none")}>作成しない（基本契約なし）</button>
            </span>
            {masterMode === "existing" && (
              <select value={existingId ?? ""} onChange={(e) => setExistingId(Number(e.target.value) || null)}>
                {masters.map((a) => <option key={a.id} value={a.id}>{a.agreementNo ?? `#${a.id}`} {a.title}（{a.status === "executed" ? "締結済" : a.status}）</option>)}
              </select>
            )}
            {masterMode === "create" && (
              <label className="row" style={{ gap: 4 }}><span className="faint">契約の件名</span>
                <input value={masterTitle} onChange={(e) => setMasterTitle(e.target.value)} style={{ minWidth: 220 }} /></label>
            )}
          </div>
          {masterMode === "none" && domain === "license" && <span className="faint">条件書は単体契約として出ます。</span>}

          {docs.map((d, i) => (
            <div key={d.uid} className="stack" style={{ gap: 4, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <b style={{ minWidth: 150 }}>{d.role === "main" ? `2. ${termsOptions[0]?.label ?? "本体"}` : `3. 追加 ${i}`}</b>
                <span className="chips" role="group">
                  <button className="chip" aria-pressed={d.on} onClick={() => setDoc(d.uid, { on: true })}>作成する</button>
                  <button className="chip" aria-pressed={!d.on} onClick={() => d.role === "extra" ? setDocs((ds) => ds.filter((x) => x.uid !== d.uid)) : setDoc(d.uid, { on: false })}>
                    {d.role === "extra" ? "外す" : "作成しない"}</button>
                </span>
                {termsOptions.length > 1 && d.on && (
                  <select value={d.templateKey} onChange={(e) => setDoc(d.uid, { templateKey: e.target.value })}>
                    {termsOptions.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                )}
                {d.role === "extra" && (
                  <select value={d.reason} onChange={(e) => setDoc(d.uid, { reason: e.target.value as DocSpec["reason"] })}>
                    {Object.entries(EXTRA_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                )}
              </div>
              {d.on && (
                <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                  <span className="faint">載せる条件</span>
                  {conditions.map((c) => (
                    <label key={c.id} className="ledger-check" style={{ whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={d.conditionIds.includes(c.id)} onChange={(e) => toggleCondition(d.uid, c.id, e.target.checked)} />
                      {" "}<span className="code">{c.conditionNo ?? `#${c.id}`}</span> {c.name}{c.work ? `（${c.work.title}）` : ""}
                    </label>
                  ))}
                  {!d.conditionIds.length && <span className="danger">条件を 1 つ以上選んでください</span>}
                </div>
              )}
            </div>
          ))}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setDocs((ds) => [...ds, { uid: uid(), role: "extra", on: true, templateKey: defaultKey, conditionIds: [], reason: "split" }])}>
              ＋ 3. 追加の{domain === "license" ? "条件書" : "発注書"}を作成する
            </button>
            <span className="faint">追加イラストなど著作物を分けるとき、複数のゲーム・出版物を作るとき。条件はどれか 1 枚に載ります</span>
          </div>
          {unassigned.length > 0 && active.length > 0 && (
            <div className="note warn">どの文書にも載っていない条件：{unassigned.map((c) => c.conditionNo ?? `#${c.id}`).join("、")}</div>
          )}
        </div>

        {/* 共通の欄 */}
        {sharedFields.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <b>共通の欄（{plan.length} 枚に入ります）</b>
            <DocumentFields fields={sharedFields} manual={shared} candidates={plan.flatMap((p) => ok(p.uid)?.candidates ?? [])} partyId={partyId}
              onChange={(n, v) => setShared((s) => ({ ...s, [n]: v }))} onPick={(n, v) => setShared((s) => ({ ...s, [n]: v }))} />
          </div>
        )}

        {/* 文書ごとの欄 */}
        {tabs.map((t) => {
          const p = previews[t.uid];
          const fields = p && !("error" in p) ? p.fields.filter((f) => !sharedNames.has(canonicalField(f.name))) : [];
          const miss = p && !("error" in p) ? p.missing.length : 0;
          return (
            <details key={t.uid} open={miss > 0}>
              <summary><b>{t.label}</b>　<span className={miss ? "danger" : "faint"}>{miss ? `未入力 ${miss}` : "入力済"}</span>
                <span className="faint">　固有の欄 {fields.length}</span></summary>
              {t.role === "extra" && mainOf(t.templateKey) && (
                <button className="btn btn-sm" style={{ margin: "6px 0" }}
                        onClick={() => setOwn((o) => ({ ...o, [t.uid]: { ...(o[mainOf(t.templateKey)!] ?? {}), ...(o[t.uid] ?? {}) } }))}>
                  本体と同じ値を入れる（入れていない欄だけ）
                </button>
              )}
              {p && "error" in p ? <div className="alert">{p.error}</div>
                : <DocumentFields fields={fields} manual={own[t.uid] ?? {}} candidates={p?.candidates ?? []} partyId={partyId}
                    onChange={(n, v) => setOwn((o) => ({ ...o, [t.uid]: { ...(o[t.uid] ?? {}), [n]: v } }))}
                    onPick={(n, v) => setOwn((o) => ({ ...o, [t.uid]: { ...(o[t.uid] ?? {}), [n]: v } }))} />}
            </details>
          );
        })}

        {/* プレビュー */}
        {tabs.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="chips" role="tablist">
              {tabs.map((t) => <button key={t.uid} className="chip" aria-pressed={shown?.uid === t.uid} onClick={() => setTab(t.uid)}>{t.label}</button>)}
            </span>
            {shownPreview && "error" in shownPreview ? <div className="alert">{shownPreview.error}</div>
              : shownPreview ? <iframe className="preview" title="文書プレビュー" srcDoc={shownPreview.html} style={{ width: "100%", minHeight: 520 }} />
              : <span className="faint">プレビューを作っています…</span>}
            {masterMode !== "none" && domain === "license" && (
              <span className="faint">条件書の「基本契約名」は、決定のときに基本契約に載せてから埋まります（プレビューでは空のことがあります）。</span>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 8 }}>
          {missing.length > 0 && <span className="danger">未入力：{missing.map((m) => `${tabs.find((t) => t.uid === m.uid)?.label ?? ""}／${m.label}`).join("、")}</span>}
          <button className="btn primary" style={{ marginLeft: "auto" }}
                  disabled={busy || !plan.length || missing.length > 0 || active.some((d) => !d.conditionIds.length) || (masterMode === "existing" && !existingId)}
                  onClick={() => void issue()}>
            {busy ? "決定しています…" : `${plan.length} 枚をまとめて決定する`}
          </button>
        </div>
        <span className="faint">決定すると番号が付き、中身は直せなくなります（直すときは各文書の「訂正版を作る」）。先に全部を確かめ、1 枚でも必須の欄が空なら何も決定しません。</span>
      </div>
    </div>
  );
}
