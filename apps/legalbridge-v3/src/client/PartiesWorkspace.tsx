import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { CreateForm, flag, int, text } from "./CreateForm.js";

interface Party {
  id: number; partyCode: string | null; name: string; kind: "corporate" | "individual";
  aliases: string[]; withholding: boolean; status: string; mergedIntoId: number | null;
}
interface PartyDetail extends Party {
  nameKana: string | null; invoiceNo: string | null; corporateNo: string | null;
  contacts: Array<{ role: string; name: string | null; email: string | null; department: string | null }>;
  references: { conditions: number; payments: number; documents: number; matters: number };
  bankAccount: { bankName: string | null } | null;
}
interface Staff { id: number; staffCode: string | null; name: string; email: string | null; department: string | null; status: string }

const ROLE_LABEL: Record<string, string> = { primary: "主担当", signer: "署名者", billing: "請求先" };

export function PartiesWorkspace() {
  const [tab, setTab] = useState<"parties" | "staff">("parties");
  const [parties, setParties] = useState<Party[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selected, setSelected] = useState<number | undefined>();
  const [detail, setDetail] = useState<PartyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function reload(select?: number) {
    Promise.all([
      api.get<{ parties: Party[] }>("/parties"),
      api.get<{ staff: Staff[] }>("/staff")
    ]).then(([p, s]) => {
      setParties(p.parties); setStaff(s.staff);
      if (select) setSelected(select);
      else if (!selected && p.parties[0]) setSelected(p.parties[0].id);
    }).catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (!selected) return;
    api.get<PartyDetail>(`/parties/${selected}`).then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>取引先・担当</h1>
        <p>屋号・ペンネーム・旧称は別名として1件にまとめる。統合しても参照は付け替えず、統合先を辿って解決する。</p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="tabs">
        <button aria-selected={tab === "parties"} onClick={() => setTab("parties")}>取引先 {parties.length}</button>
        <button aria-selected={tab === "staff"} onClick={() => setTab("staff")}>担当者 {staff.length}</button>
        {tab === "parties" && !creating && (
          <button className="btn primary btn-sm" onClick={() => setCreating(true)}>取引先を登録</button>
        )}
      </div>

      {creating && (
        <CreateForm
          title="取引先の登録"
          path="/parties"
          initial={{ kind: "corporate" }}
          fields={[
            { name: "name", label: "名称", required: true, placeholder: "株式会社◯◯" },
            { name: "kind", label: "区分", type: "select", required: true,
              options: [{ value: "corporate", label: "法人" }, { value: "individual", label: "個人" }],
              hint: "個人は取適法の特定受託事業者として扱い、支払期日を60日で検査する" },
            { name: "nameKana", label: "カナ" },
            { name: "invoiceNo", label: "インボイス登録番号", placeholder: "T1234567890123" },
            { name: "corporateNo", label: "法人番号",
              visibleWhen: (v) => v.kind !== "individual" },
            { name: "withholding", label: "源泉徴収の対象", type: "checkbox" },
            { name: "aliases", label: "別名（屋号・ペンネーム・旧称）", type: "textarea",
              hint: "改行で区切る。名寄せの手がかりになる" }
          ]}
          toPayload={(v) => ({
            name: text(v.name), kind: v.kind, nameKana: text(v.nameKana),
            invoiceNo: text(v.invoiceNo), corporateNo: text(v.corporateNo),
            withholding: flag(v.withholding) ?? false,
            aliases: String(v.aliases ?? "").split("\n").map((a) => a.trim()).filter(Boolean)
          })}
          retryOnConflict={{ label: "同名でも新規に作る", extra: { allowDuplicate: true } }}
          onDone={(r) => { setCreating(false); reload(r.id); }}
          onCancel={() => setCreating(false)}
        />
      )}

      {tab === "staff" ? (
        <div className="panel">
          <div className="panel-hd"><h2>担当者</h2></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>コード</th><th>氏名</th><th>部門</th><th>メール</th><th>状態</th></tr></thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td className="code">{s.staffCode ?? `#${s.id}`}</td><td>{s.name}</td>
                    <td>{s.department ?? "—"}</td><td className="faint">{s.email ?? "—"}</td>
                    <td><span className="tag">{s.status}</span></td>
                  </tr>
                ))}
                {!staff.length && <tr><td colSpan={5} className="faint">担当者がいません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="panel">
            <div className="panel-hd"><h2>一覧</h2></div>
            <div className="tablewrap">
              <table>
                <thead><tr><th>コード</th><th>名称</th><th>区分</th><th>源泉</th><th>状態</th></tr></thead>
                <tbody>
                  {parties.map((p) => (
                    <tr key={p.id} className={p.id === selected ? "sel" : ""} onClick={() => setSelected(p.id)}>
                      <td className="code">{p.partyCode ?? `#${p.id}`}</td>
                      <td className={p.status === "merged" ? "faint" : ""}>{p.name}</td>
                      <td>{p.kind === "individual" ? "個人" : "法人"}</td>
                      <td>{p.withholding ? <span className="tag warn">あり</span> : "—"}</td>
                      <td><span className="tag">
                        {p.status === "merged" ? `#${p.mergedIntoId} へ統合` : p.status}
                      </span></td>
                    </tr>
                  ))}
                  {!parties.length && <tr><td colSpan={5} className="faint">取引先がありません</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="stack">
            {detail && (
              <>
                <div className="panel">
                  <div className="panel-hd">
                    <h2 className="code">{detail.partyCode ?? `#${detail.id}`}</h2>
                    <span>{detail.name}</span>
                    <span className="tag">{detail.kind === "individual" ? "個人" : "法人"}</span>
                  </div>
                  <div className="panel-bd">
                    <dl className="dl">
                      <dt>別名</dt>
                      <dd>{detail.aliases.length
                        ? <span className="chips">{detail.aliases.map((a) => <span key={a} className="tag">{a}</span>)}</span>
                        : "—"}</dd>
                      <dt>カナ</dt><dd>{detail.nameKana ?? "—"}</dd>
                      <dt>登録番号</dt><dd className="code">{detail.invoiceNo ?? "—"}</dd>
                      <dt>源泉</dt><dd>{detail.withholding ? "対象" : detail.kind === "individual" ? "個人のため対象" : "対象外"}</dd>
                      <dt>口座</dt>
                      <dd className="faint">{detail.bankAccount?.bankName ?? "非表示（別権限）"}</dd>
                    </dl>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-hd"><h2>連絡先</h2></div>
                  <div className="tablewrap">
                    <table>
                      <thead><tr><th>役割</th><th>氏名</th><th>メール</th><th>部門</th></tr></thead>
                      <tbody>
                        {detail.contacts.map((c) => (
                          <tr key={c.role}>
                            <td>{ROLE_LABEL[c.role] ?? c.role}</td><td>{c.name ?? "—"}</td>
                            <td className="faint">{c.email ?? "—"}</td><td>{c.department ?? "—"}</td>
                          </tr>
                        ))}
                        {!detail.contacts.length && <tr><td colSpan={4} className="faint">連絡先がありません</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-hd"><h2>参照している実体</h2><span className="faint">名寄せの影響範囲</span></div>
                  <div className="panel-bd">
                    <dl className="dl">
                      <dt>条件</dt><dd>{detail.references.conditions}件</dd>
                      <dt>支払</dt><dd>{detail.references.payments}件</dd>
                      <dt>合意</dt><dd>{detail.references.documents}件</dd>
                      <dt>案件</dt><dd>{detail.references.matters}件</dd>
                    </dl>
                    <div className="faint" style={{ marginTop: 9 }}>
                      統合しても参照は付け替えません。統合先を辿って解決するためです。
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
