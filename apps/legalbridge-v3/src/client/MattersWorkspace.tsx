import { useEffect, useState } from "react";
import type { MatterDetail, MatterKind, MatterSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";

const KIND_LABEL: Record<MatterKind, string> = {
  work: "作品フロー", outsourcing: "業務委託フロー", single: "単発フロー"
};
const STEPS: Record<MatterKind, string[]> = {
  work: ["権利の上限確認", "条件の合意", "契約書の締結", "実績の受領", "計算書と分配"],
  outsourcing: ["基本契約の確認", "発注（明示事項）", "納品・報告", "検収", "支払"],
  single: ["相談の受付", "ひな形の選定", "締結", "完了"]
};

type Tab = "conditions" | "documents" | "payments" | "communications";

export function MattersWorkspace({ onOpenCondition }: { onOpenCondition: (id: number) => void }) {
  const [rows, setRows] = useState<MatterSummary[]>([]);
  const [selected, setSelected] = useState<number | undefined>();
  const [detail, setDetail] = useState<MatterDetail | null>(null);
  const [kind, setKind] = useState<MatterKind | "all">("all");
  const [tab, setTab] = useState<Tab>("conditions");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ matters: MatterSummary[] }>(`/matters${kind === "all" ? "" : `?kind=${kind}`}`)
      .then((r) => { setRows(r.matters); if (r.matters[0]) setSelected(r.matters[0].id); })
      .catch((e: ApiError) => setError(e.message));
  }, [kind]);

  useEffect(() => {
    if (!selected) return;
    setTab("conditions");
    api.get<MatterDetail>(`/matters/${selected}`).then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>案件</h1>
        <p>すべての作業の入口。フロー種別が中身を決め、条件・文書・支払・連絡がその下にぶら下がる。</p>
      </header>

      <div className="filters">
        {(["all", "work", "outsourcing", "single"] as const).map((value) => (
          <button key={value} className="chip" aria-pressed={kind === value} onClick={() => setKind(value)}>
            {value === "all" ? "すべて" : KIND_LABEL[value]}
          </button>
        ))}
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="split">
        <div className="panel">
          <div className="panel-hd"><h2>一覧</h2></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>案件番号</th><th>フロー</th><th>件名 / 相手先</th><th>状態</th><th>期日</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={row.id === selected ? "sel" : ""} onClick={() => setSelected(row.id)}>
                    <td className="code">{row.matterNo ?? `#${row.id}`}</td>
                    <td><span className="tag accent">{KIND_LABEL[row.kind]}</span></td>
                    <td>{row.title}<div className="faint">{row.counterparty?.name ?? "—"}</div></td>
                    <td><span className="tag">{row.status}</span></td>
                    <td className="code">{row.dueOn ?? "—"}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className="faint">案件がありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="stack">
          {detail && (
            <>
              <div className="panel">
                <div className="panel-hd">
                  <h2 className="code">{detail.matterNo ?? `#${detail.id}`}</h2>
                  <span className="tag accent">{KIND_LABEL[detail.kind]}</span>
                  <span className="tag">{detail.status}</span>
                </div>
                <div className="panel-bd stack">
                  <div className="title">{detail.title}</div>
                  <div className="pipe">
                    {STEPS[detail.kind].map((step, index) => (
                      <div key={step} className="pipe-step">
                        <span className="st">{index + 1}</span><span className="nm">{step}</span>
                      </div>
                    ))}
                  </div>
                  <dl className="dl">
                    <dt>相手先</dt><dd>{detail.counterparty?.name ?? "—"}</dd>
                    <dt>担当</dt><dd>{detail.ownerName ?? "未設定"}</dd>
                    {detail.blockedReason && (<><dt>停滞理由</dt><dd>{detail.blockedReason}</dd></>)}
                  </dl>
                </div>
              </div>

              <div className="panel">
                <div className="panel-hd"><h2>この案件の中身</h2></div>
                <div className="panel-bd">
                  <div className="tabs">
                    {([["conditions", `条件 ${detail.conditions.length}`],
                       ["documents", `文書 ${detail.documents.length}`],
                       ["payments", `支払 ${detail.payments.length}`],
                       ["communications", `連絡履歴 ${detail.communications.length}`]] as const).map(([key, label]) => (
                      <button key={key} aria-selected={tab === key} onClick={() => setTab(key as Tab)}>{label}</button>
                    ))}
                  </div>

                  {tab === "conditions" && (
                    detail.conditions.length ? (
                      <table>
                        <thead><tr><th>条件番号</th><th>向き</th><th>内容</th></tr></thead>
                        <tbody>
                          {detail.conditions.map((c) => (
                            <tr key={c.id} onClick={() => onOpenCondition(c.id)}>
                              <td className="code">{c.conditionNo ?? `#${c.id}`}</td>
                              <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                              <td>{c.name}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="note">
                        この案件は条件を持ちません。秘密保持契約・通知書・法務相談など、
                        金銭条件も権利の移動も伴わない案件がこれにあたります。
                      </div>
                    )
                  )}

                  {tab === "documents" && (
                    <table>
                      <thead><tr><th>文書番号</th><th>種別</th><th>状態</th></tr></thead>
                      <tbody>
                        {detail.documents.map((d) => (
                          <tr key={d.id}>
                            <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                            <td>{d.templateLabel ?? "—"}</td><td>{d.status}</td>
                          </tr>
                        ))}
                        {!detail.documents.length && <tr><td colSpan={3} className="faint">文書はありません</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {tab === "payments" && (
                    <table>
                      <thead><tr><th>支払番号</th><th>向き</th><th className="num">金額</th><th>期日</th><th>状態</th></tr></thead>
                      <tbody>
                        {detail.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="code">{p.paymentNo ?? `#${p.id}`}</td>
                            <td>{p.direction === "in" ? "入金" : "支払"}</td>
                            <td className="num">{money(p.amount, p.currency)}</td>
                            <td className="code">{p.dueOn ?? "—"}</td><td>{p.status}</td>
                          </tr>
                        ))}
                        {!detail.payments.length && <tr><td colSpan={5} className="faint">支払はありません</td></tr>}
                      </tbody>
                    </table>
                  )}

                  {tab === "communications" && (
                    <table>
                      <thead><tr><th>日時</th><th>操作</th><th>実行者</th></tr></thead>
                      <tbody>
                        {detail.communications.map((c, index) => (
                          <tr key={`${c.occurredAt}-${index}`}>
                            <td className="code">{c.occurredAt.slice(0, 16).replace("T", " ")}</td>
                            <td className="code">{c.action}</td><td>{c.actor}</td>
                          </tr>
                        ))}
                        {!detail.communications.length && <tr><td colSpan={3} className="faint">記録はありません</td></tr>}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-hd"><h2>参照しているマスタ</h2><span className="faint">案件より長生きする実体</span></div>
                <div className="panel-bd">
                  <table>
                    <thead><tr><th>種別</th><th>参照</th><th>関係</th></tr></thead>
                    <tbody>
                      {detail.links.map((l) => (
                        <tr key={`${l.targetType}-${l.targetRef}`}>
                          <td>{l.targetType}</td><td className="code">{l.targetRef}</td><td>{l.relation}</td>
                        </tr>
                      ))}
                      {!detail.links.length && <tr><td colSpan={3} className="faint">リンクはありません</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
