import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import type { AgreementVersion } from "../server/agreements/versions.js";

/**
 * 契約の記録の版と履歴（infra/v3/208_agreement_versions.sql）。
 *
 * 契約の記録は 1 行を上書きするが、登録・変更のたびにその時点の中身が版として残る。
 * ここは版の一覧（新しい順）：いつ・だれが・なぜ・何を（前の値 → 新しい値）。
 * 208 を流していない環境では「履歴はまだ取っていません」とだけ出す。
 */

const KIND_TEXT: Record<AgreementVersion["kind"], string> = {
  baseline: "履歴を取り始めた時点", created: "登録", changed: "変更", deleted: "削除"
};
const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** まき直し・更新・訂正など、よくある理由。 */
export const VERSION_REASONS = ["契約のまき直し", "更新・期間の変更", "締結の記録", "登録の訂正"];

/** 変更の理由の欄（編集のフォームに置く）。 */
export function VersionReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" style={{ gridColumn: "1 / -1" }}><span>変更の理由（履歴に残ります）</span>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="例：2026年12月に契約をまき直した" style={{ flex: "1 1 260px" }} />
        {VERSION_REASONS.map((r) => (
          <button key={r} type="button" className="chip" aria-pressed={value === r} onClick={() => onChange(value === r ? "" : r)}>{r}</button>
        ))}
      </span>
    </label>
  );
}

function useVersions(agreementId: number, version = 0) {
  const [data, setData] = useState<{ available: boolean; versions: AgreementVersion[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null); setError(null);
    api.get<{ available: boolean; versions: AgreementVersion[] }>(`/agreements/${agreementId}/versions`)
      .then((r) => { if (alive) setData(r); })
      .catch((e: ApiError) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [agreementId, version]);
  return { data, error };
}

/** 版の一覧（表）。 */
export function AgreementVersionsList({ agreementId, version = 0 }: { agreementId: number; version?: number }) {
  const { data, error } = useVersions(agreementId, version);
  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="faint">読み込み中…</div>;
  if (!data.available) {
    return <div className="faint">履歴はまだ取っていません（データベースに 208_agreement_versions.sql を流すと、変更のたびに版が残ります）。</div>;
  }
  if (!data.versions.length) return <div className="faint">版の記録がありません。</div>;
  return (
    <table className="table">
      <thead><tr><th>版</th><th>日時</th><th>だれが</th><th>何を</th><th>理由</th></tr></thead>
      <tbody>
        {data.versions.map((v, i) => (
          <tr key={v.versionNo}>
            <td style={{ whiteSpace: "nowrap" }}><b>第 {v.versionNo} 版</b>{i === 0 && v.kind !== "deleted" && <span className="tag ok" style={{ marginLeft: 4 }}>いま</span>}</td>
            <td className="faint" style={{ whiteSpace: "nowrap" }}>{when(v.changedAt)}</td>
            <td>{v.changedBy ?? <span className="faint">自動</span>}</td>
            <td>
              {v.changes.length ? (
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {v.changes.map((c) => (
                    <li key={c.field}>{c.label}：<span className="faint">{c.from}</span> → <b>{c.to}</b></li>
                  ))}
                </ul>
              ) : (
                <span>
                  {KIND_TEXT[v.kind]}
                  <span className="faint">（{[v.summary.agreementNo, v.summary.title,
                    v.summary.executedOn ? `締結 ${v.summary.executedOn}` : "未締結",
                    v.summary.effectiveOn || v.summary.expiresOn ? `${v.summary.effectiveOn ?? ""}〜${v.summary.expiresOn ?? "期限なし"}` : null,
                    v.summary.terminatedOn ? `終了 ${v.summary.terminatedOn}` : null].filter(Boolean).join("・")}）</span>
                </span>
              )}
            </td>
            <td>{v.reason ?? <span className="faint">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 「履歴」ボタン（ポップアップで版の一覧）。 */
export function AgreementVersionsButton({ agreementId, title, className = "btn btn-sm" }: {
  agreementId: number; title: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} title="この契約の記録の版（いつ・だれが・何を変えたか）" onClick={() => setOpen(true)}>履歴</button>
      {open && (
        <Modal title={`${title} の記録の履歴`} onClose={() => setOpen(false)} wide>
          <div className="stack" style={{ gap: 8 }}>
            <div className="faint">契約の記録（締結日・期間・状態・親の契約など）を変えるたびに版が増えます。前の版の中身は消えません。</div>
            <AgreementVersionsList agreementId={agreementId} />
          </div>
        </Modal>
      )}
    </>
  );
}
