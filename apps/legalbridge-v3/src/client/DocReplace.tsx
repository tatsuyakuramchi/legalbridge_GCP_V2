import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import { useDebounced } from "./ListTools.js";
import { searchDocs, STATUS, type DocHit } from "./DocAttach.js";

/**
 * 契約の文書を差し替える（POST /agreement-map/agreements/:id/replace-document）。
 *
 *   1. 差し替える（古い）文書を選ぶ   … この契約の決定済みの文書。何枚でも
 *   2. 理由を入れる                  … 履歴に残る
 *   3. 新しい文書を選ぶ              … この契約に繋がっているほかの文書、または探して選ぶ（署名済みの PDF など）
 *
 * 古い文書は「差し替え済み」になり、載っていた条件明細は新しい文書に引き継ぐ。
 * 契約の番号・条件明細・計算書・支払は変えない。
 */

export interface ReplaceTarget {
  id: number; agreementNo: string | null; kind: string | null; partyId: number;
  /** 「文書」の一覧の行から開いたとき、その文書を古い側に選んでおく。 */
  oldId?: number | null;
}

interface ContractDoc {
  id: number; documentNo: string | null; label: string; title: string | null; status: string;
  issuedOn: string | null; imported: boolean; agreementId: number | null; conditionCount: number;
}

const REASONS = ["署名済みの版に差し替え", "新しいひな形で作り直した版に差し替え", "重複して作った文書を整理"];

/** 決定日の新しい順（同じ日は id の大きい順）。 */
const newestFirst = (a: ContractDoc, b: ContractDoc) =>
  (b.issuedOn ?? "").localeCompare(a.issuedOn ?? "") || b.id - a.id;

/**
 * 最初に選んでおくもの。行から開いたらその文書を古い側に、新しい側はこの契約のほかの文書でいちばん新しいもの。
 * 一覧から開いて 2 枚以上あれば、いちばん新しいものを新しい側、残りを古い側に。1 枚ならそれを古い側に。
 */
export function initialReplacePick(docs: ContractDoc[], oldId: number | null | undefined): { olds: number[]; next: number | null } {
  const sorted = [...docs].sort(newestFirst);
  if (oldId && sorted.some((d) => d.id === oldId)) {
    return { olds: [oldId], next: sorted.find((d) => d.id !== oldId)?.id ?? null };
  }
  if (sorted.length >= 2) return { olds: sorted.slice(1).map((d) => d.id), next: sorted[0]!.id };
  return { olds: sorted.map((d) => d.id), next: null };
}

export function ReplaceDocDialog({ target, onDone, onClose }: {
  target: ReplaceTarget; onDone: (msg: string) => void; onClose: () => void;
}) {
  const no = target.agreementNo ?? `契約 #${target.id}`;
  const [docs, setDocs] = useState<ContractDoc[] | null>(null);
  const [olds, setOlds] = useState<number[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const query = useDebounced(q, 250);
  const [hits, setHits] = useState<DocHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<{ documents: ContractDoc[] }>(`/agreement-map/agreements/${target.id}/documents`)
      .then((r) => {
        if (!alive) return;
        // この契約の決定済みの文書。個別契約なら、親の基本契約に付いた作品ごとに番号の条件書も出る。
        const mine = r.documents.filter((d) => d.status === "issued" && (d.agreementId === target.id || target.kind === "supplement"));
        setDocs(mine);
        const pick = initialReplacePick(mine, target.oldId);
        setOlds(pick.olds); setNext(pick.next);
      })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [target.id, target.kind, target.oldId]);

  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    let alive = true;
    searchDocs(target.partyId, query).then((h) => { if (alive) setHits(h); }).catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [target.partyId, query]);

  const byId = useMemo(() => new Map((docs ?? []).map((d) => [d.id, d])), [docs]);
  const others = (docs ?? []).filter((d) => !olds.includes(d.id)).sort(newestFirst);
  const found = (hits ?? []).filter((h) => !byId.has(h.id));
  const nextLabel = (() => {
    if (next === null) return null;
    const d = byId.get(next) ?? hits?.find((h) => h.id === next);
    return d ? d.documentNo ?? `文書 #${next}` : `文書 #${next}`;
  })();
  const oldNos = olds.map((id) => byId.get(id)?.documentNo ?? `#${id}`);
  const toggleOld = (id: number) => {
    setOlds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    if (next === id) setNext(null);
  };
  const lacks = [!olds.length ? "差し替える文書" : "", !reason.trim() ? "理由" : "", next === null ? "新しい文書" : ""].filter(Boolean);

  async function go() {
    if (next === null) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ documentNo: string | null; replacedNos: string[]; conditionsLinked: number; fromAgreementNo: string | null }>(
        `/agreement-map/agreements/${target.id}/replace-document`, { replacesIds: olds, documentId: next, reason: reason.trim() });
      onDone(`${no} の文書を ${r.documentNo ?? nextLabel} に差し替えました（${r.replacedNos.join("・")} は差し替え済み`
        + `${r.conditionsLinked ? `・条件明細 ${r.conditionsLinked} 本を引き継ぎ` : ""}${r.fromAgreementNo ? `・${r.fromAgreementNo} から付け替え` : ""}）`);
      onClose();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  const docLine = (d: { documentNo: string | null; label?: string | null; title: string | null; issuedOn?: string | null; conditionCount?: number }) => (
    <span className="ct-pick-main">
      <span className="ct-line">
        <span className="code">{d.documentNo ?? "（番号なし）"}</span>
        <span>{d.label}</span>
        {d.issuedOn && <span className="faint" style={{ marginLeft: "auto" }}>決定 {d.issuedOn}</span>}
      </span>
      {(d.title || d.conditionCount) && (
        <span className="faint">{[d.title, d.conditionCount ? `条件 ${d.conditionCount} 本` : ""].filter(Boolean).join("・")}</span>
      )}
    </span>
  );

  return (
    <Modal title={`${no} の文書を差し替える`} onClose={onClose} wide>
      <div className="stack" style={{ gap: 12 }}>
        {!docs && !error && <div className="faint">読み込み中…</div>}
        {docs && !docs.length && <div className="note warn">この契約に決定済みの文書がありません。差し替えではなく「＋ 文書を足す」で付けてください。</div>}
        {docs && docs.length > 0 && (
          <>
            <section className="stack" style={{ gap: 6 }}>
              <b>1. 差し替える文書（古い方）</b>
              <div className="ct-pick">
                {docs.map((d) => (
                  <label key={d.id} className={`ct-pick-row${olds.includes(d.id) ? " on" : ""}`}>
                    <input type="checkbox" checked={olds.includes(d.id)} onChange={() => toggleOld(d.id)} />
                    {docLine(d)}
                  </label>
                ))}
              </div>
              <small className="faint">チェックした文書は「差し替え済み」になります（記録は残ります）。</small>
            </section>

            <section className="stack" style={{ gap: 6 }}>
              <b>2. 理由</b>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例：署名済みの版に差し替え" aria-label="差し替えの理由" />
              <div className="chips">
                {REASONS.map((r) => <button key={r} type="button" className="chip" onClick={() => setReason(r)}>{r}</button>)}
              </div>
            </section>

            <section className="stack" style={{ gap: 6 }}>
              <b>3. 新しい文書</b>
              <div className="ct-pick">
                {others.map((d) => (
                  <label key={d.id} className={`ct-pick-row${next === d.id ? " on" : ""}`}>
                    <input type="radio" name="next" checked={next === d.id} onChange={() => setNext(d.id)} />
                    {docLine(d)}
                  </label>
                ))}
                {!others.length && <div className="faint" style={{ padding: 8 }}>この契約にほかの文書はありません。下で探してください。</div>}
              </div>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
                     placeholder="ほかの文書を探す（文書番号・件名。上げた PDF もここで）" aria-label="新しい文書を探す" />
              {hits && (
                <div className="ct-pick">
                  {found.map((d) => (
                    <label key={d.id} className={`ct-pick-row${next === d.id ? " on" : ""}${d.status !== "issued" ? " off" : ""}`}>
                      <input type="radio" name="next" disabled={d.status !== "issued"} checked={next === d.id} onChange={() => setNext(d.id)} />
                      <span className="ct-pick-main">
                        <span className="ct-line">
                          <span className="tag">{d.imported ? "取込" : d.templateLabel ?? "文書"}</span>
                          <span className="code">{d.documentNo ?? "（番号なし）"}</span>
                          <span>{d.title}</span>
                          <span className="faint" style={{ marginLeft: "auto" }}>{STATUS[d.status] ?? d.status}</span>
                        </span>
                        <span className="faint">{[d.issuedAt?.slice(0, 10),
                          d.agreementId ? "ほかの契約に繋がっています（この契約に付け替え）" : "契約に繋がっていません",
                          d.status !== "issued" ? "決定済みでないので選べません" : ""].filter(Boolean).join("・")}</span>
                      </span>
                    </label>
                  ))}
                  {!found.length && <div className="faint" style={{ padding: 8 }}>見つかりません。</div>}
                </div>
              )}
              <small className="faint">まだ登録していない PDF は、先に「＋ 文書を足す」→「作成済みの文書を上げる」で登録してから選んでください。</small>
            </section>

            {lacks.length === 0 && (
              <div className="note">
                <b>{oldNos.join("・")}</b> を差し替え済みにして、<b>{nextLabel}</b> を {no} の文書にします。
                条件明細は {nextLabel} に引き継ぎ、契約の番号・条件明細・計算書・支払は変わりません。
              </div>
            )}
          </>
        )}
        {error && <div className="alert">{error}</div>}
        <div className="row" style={{ gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {docs && docs.length > 0 && lacks.length > 0 && <span className="faint">{lacks.join("・")}を選んでください</span>}
          <button className="btn" onClick={onClose} disabled={busy}>やめる</button>
          <button className="btn primary" disabled={busy || lacks.length > 0} onClick={() => void go()}>{busy ? "差し替えています…" : "差し替える"}</button>
        </div>
      </div>
    </Modal>
  );
}
