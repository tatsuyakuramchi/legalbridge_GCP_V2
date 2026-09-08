import { useEffect, useState } from "react";
import type { MatterDetail, MatterKind, MatterSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import { CreateForm, int, text } from "./CreateForm.js";

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
  const [creating, setCreating] = useState<"matter" | "task" | null>(null);
  const [parties, setParties] = useState<Array<{ id: number; name: string }>>([]);
  const [staff, setStaff] = useState<Array<{ id: number; name: string }>>([]);

  function reloadMatters(select?: number) {
    api.get<{ matters: MatterSummary[] }>(`/matters${kind === "all" ? "" : `?kind=${kind}`}`)
      .then((r) => { setRows(r.matters); if (select) setSelected(select); else if (!selected && r.matters[0]) setSelected(r.matters[0].id); })
      .catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reloadMatters(); }, [kind]);

  // 選択肢。登録フォームでしか使わないので、開くまで取りに行かない。
  useEffect(() => {
    if (creating === null || parties.length) return;
    Promise.all([
      api.get<{ parties: Array<{ id: number; name: string }> }>("/parties"),
      api.get<{ staff: Array<{ id: number; name: string }> }>("/staff")
    ]).then(([p, st]) => { setParties(p.parties); setStaff(st.staff); }).catch(() => undefined);
  }, [creating]);

  function reloadDetail() {
    if (!selected) return;
    api.get<MatterDetail>(`/matters/${selected}`).then(setDetail).catch((e: ApiError) => setError(e.message));
  }

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

      <div className="row" style={{ marginBottom: 10 }}>
        {creating === null && (
          <>
            <button className="btn primary btn-sm" onClick={() => setCreating("matter")}>案件を登録</button>
            {selected && <button className="btn btn-sm" onClick={() => setCreating("task")}>タスクを追加</button>}
          </>
        )}
      </div>

      {creating === "matter" && (
        <CreateForm
          title="案件の登録"
          path="/matters"
          initial={{ kind: "single" }}
          fields={[
            { name: "title", label: "案件名", required: true },
            { name: "kind", label: "フロー種別", type: "select", required: true,
              options: [{ value: "work", label: "作品フロー" }, { value: "outsourcing", label: "業務委託フロー" },
                        { value: "single", label: "条件なしフロー" }],
              hint: "必須項目・検査・使えるテンプレートをこれが決める。後から変えると影響が大きい" },
            { name: "counterpartyId", label: "相手先", type: "select",
              options: parties.map((p) => ({ value: String(p.id), label: p.name })) },
            { name: "ownerStaffId", label: "担当者", type: "select",
              options: staff.map((p) => ({ value: String(p.id), label: p.name })) },
            { name: "dueOn", label: "期日", type: "date" },
            { name: "requesterEmail", label: "依頼者メール" },
            { name: "remarks", label: "備考", type: "textarea" }
          ]}
          toPayload={(v) => ({
            title: text(v.title), kind: v.kind,
            counterpartyId: int(v.counterpartyId), ownerStaffId: int(v.ownerStaffId),
            dueOn: text(v.dueOn), requesterEmail: text(v.requesterEmail), remarks: text(v.remarks)
          })}
          onDone={(r) => { setCreating(null); reloadMatters(r.id); }}
          onCancel={() => setCreating(null)}
        />
      )}

      {creating === "task" && selected && (
        <CreateForm
          title="タスクの追加"
          path={`/matters/${selected}/tasks`}
          fields={[
            { name: "title", label: "やること", required: true },
            { name: "assigneeStaffId", label: "担当者", type: "select",
              options: staff.map((p) => ({ value: String(p.id), label: p.name })) },
            { name: "dueAt", label: "期日", type: "date",
              hint: "期日を入れると期限一覧に出る。過ぎたものは全部表示される" },
            { name: "description", label: "内容", type: "textarea" }
          ]}
          toPayload={(v) => ({
            title: text(v.title), assigneeStaffId: int(v.assigneeStaffId),
            dueAt: v.dueAt ? new Date(`${v.dueAt}T09:00:00+09:00`).toISOString() : undefined,
            description: text(v.description)
          })}
          onDone={() => { setCreating(null); reloadDetail(); }}
          onCancel={() => setCreating(null)}
        />
      )}

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
