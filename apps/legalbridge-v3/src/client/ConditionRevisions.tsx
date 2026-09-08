import { useEffect, useState } from "react";
import { api, ApiError, money, rate } from "./api.js";
import type { ConditionRevision } from "../server/core/model.js";

/**
 * 改訂の履歴（修正前と修正後、そのどれが生きているか）。
 *
 * 契約変更で金額を直すと、旧版を残して新版が立つ。データにはその連鎖が
 * 記録されていたが、読む処理がどこにも無く、画面からは「いま有効な版」
 * しか見えなかった。前がいくらだったのか、どれが生きているのかを出す。
 *
 * 差分は隣の版と比べて出す。全項目を並べると、変わっていない値のほうが
 * 多くて、変わった1項目が埋もれる。
 */

const TAX_LABEL: Record<string, string> = {
  taxable: "課税 10%", reduced: "軽減 8%", exempt: "非課税・不課税"
};

interface FieldDiff { label: string; before: string; after: string }

/** 前の版との違い。金額は通貨付きで、料率は % で見せる。 */
function diff(before: ConditionRevision, after: ConditionRevision): FieldDiff[] {
  const out: FieldDiff[] = [];
  const push = (label: string, a: string, b: string) => {
    if (a !== b) out.push({ label, before: a, after: b });
  };
  const yen = (v: number | null, c: string) => (v === null ? "—" : money(v, c));

  push("条件名", before.name, after.name);
  push("相手先", before.counterparty?.name ?? "—", after.counterparty?.name ?? "—");
  push("料率", rate(before.ratePpm), rate(after.ratePpm));
  push("定額", yen(before.flatAmount, before.currency), yen(after.flatAmount, after.currency));
  push("単価", yen(before.unitAmount, before.currency), yen(after.unitAmount, after.currency));
  push("MG", yen(before.mgAmount, before.currency), yen(after.mgAmount, after.currency));
  push("AG", yen(before.agAmount, before.currency), yen(after.agAmount, after.currency));
  push("開始", before.termStart ?? "—", after.termStart ?? "—");
  push("終了", before.termEnd ?? "期限なし", after.termEnd ?? "期限なし");
  push("税区分", TAX_LABEL[before.taxCategory] ?? before.taxCategory,
       TAX_LABEL[after.taxCategory] ?? after.taxCategory);
  push("支払条件", before.paymentTerms ?? "—", after.paymentTerms ?? "—");
  return out;
}

export function ConditionRevisions(
  { conditionId, onOpen }: { conditionId: number; onOpen: (id: number) => void }
) {
  const [rows, setRows] = useState<ConditionRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null); setError(null);
    api.get<{ revisions: ConditionRevision[] }>(`/conditions/${conditionId}/revisions`)
      .then((r) => setRows(r.revisions))
      .catch((e: ApiError) => { setError(e.message); setRows([]); });
  }, [conditionId]);

  // 版が1つだけなら履歴として見せる意味がない。
  if (!rows || rows.length <= 1) {
    return error ? <div className="alert">{error}</div> : null;
  }

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>契約変更の履歴</h2>
        <span className="faint">{rows.length} 版　／　生きているのは1つだけ</span>
      </div>
      <div className="panel-bd stack">
        {rows.map((r, i) => {
          const changes = i > 0 ? diff(rows[i - 1], r) : [];
          return (
            <div key={r.id} className="trace" style={{
              borderColor: r.live ? "var(--ok)" : "var(--line)",
              opacity: r.live ? 1 : 0.85
            }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="tag accent">第 {r.revision} 版</span>
                <button className="btn btn-sm code" onClick={() => onOpen(r.id)}
                        disabled={r.id === conditionId}>
                  {r.conditionNo ?? `#${r.id}`}
                </button>
                {r.live
                  ? <span className="tag ok">いま有効</span>
                  : <span className="tag">{r.status === "superseded" ? "差し替え済み"
                      : r.status === "void" ? "無効" : "下書き"}</span>}
                <span className="faint" style={{ marginLeft: "auto" }}>
                  {r.createdAt.slice(0, 10)}
                  {r.eventCount > 0 && `　実績 ${r.eventCount} 件`}
                  {r.documentCount > 0 && `　文書 ${r.documentCount} 件`}
                </span>
              </div>

              {i === 0 ? (
                <div className="trace-line faint">最初の版</div>
              ) : changes.length ? (
                changes.map((c) => (
                  <div key={c.label} className="trace-line">
                    {c.label}：<span className="faint">{c.before}</span>
                    <span style={{ margin: "0 6px" }}>→</span>
                    <b>{c.after}</b>
                  </div>
                ))
              ) : (
                <div className="trace-line faint">金額・期間・相手先に違いはありません</div>
              )}
            </div>
          );
        })}

        <p className="faint" style={{ margin: 0 }}>
          過去の計算書・支払は、作られた時点の版を指したままです。版を差し替えても
          遡って書き換わりません。
        </p>
      </div>
    </div>
  );
}
