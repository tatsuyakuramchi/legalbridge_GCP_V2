import { useEffect, useState } from "react";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { PARTY_KIND_LABEL, StatusTag } from "./labels.js";
import { api, ApiError } from "./api.js";
import { Relations, type EntityKind } from "./Relations.js";
import { CreateForm, flag, int, text } from "./CreateForm.js";
import { PartyMerge } from "./PartyMerge.js";

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
interface Staff {
  id: number; staffCode: string | null; name: string;
  email: string | null; department: string | null; phone: string | null; status: string;
}

const ROLE_LABEL: Record<string, string> = { primary: "主担当", signer: "署名者", billing: "請求先" };

export function PartiesWorkspace(
  { initialId, onOpen }: {
    initialId?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
  } = {}
) {
  const [tab, setTab] = useState<"parties" | "staff" | "merge">("parties");
  const [parties, setParties] = useState<Party[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<PartyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "corporate" | "individual">("all");
  const [total, setTotal] = useState<number | null>(null);
  const query = useDebounced(keyword);
  // 在籍していてメールの無い人。退職者は書類に出ないので数えない。
  const noMail = staff.filter((s) => s.status === "active" && !s.email);

  function reload(select?: number) {
    const q = query.trim();
    Promise.all([
      api.get<{ parties: Party[] }>(`/parties${q ? `?q=${encodeURIComponent(q)}` : ""}`),
      api.get<{ staff: Staff[] }>("/staff")
    ]).then(([p, s]) => {
      setParties(p.parties); setStaff(s.staff);
      // 絞り込みなしの件数は、絞っていないときの結果をそのまま覚えておく。
      if (!q) setTotal(p.parties.length);
      if (select) setSelected(select);
      else if (!selected && p.parties[0]) setSelected(p.parties[0].id);
    }).catch((e: ApiError) => setError(e.message));
  }
  useEffect(() => { reload(); }, [query]);

  useEffect(() => {
    if (!selected) return;
    api.get<PartyDetail>(`/parties/${selected}`).then(setDetail)
      .catch((e: ApiError) => setError(e.message));
  }, [selected]);

  const shown = parties.filter((p) => kindFilter === "all" || p.kind === kindFilter);

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
        <button aria-selected={tab === "merge"} onClick={() => setTab("merge")}>名寄せ</button>
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

      {tab === "merge" ? (
        <PartyMerge onDone={() => reload()} />
      ) : tab === "staff" ? (
        <div className="panel">
          <div className="panel-hd">
            <h2>担当者</h2>
            <span className="faint">
              検収書の【ご連絡先】と発注書の担当欄に、この部署・氏名・メール・電話が出ます
            </span>
          </div>
          {/* メールの空欄は、検収書が「5営業日以内に下記へ異議を」と書いている
              その連絡先が無いということ。件数で見えるようにする。 */}
          {noMail.length > 0 && (
            <div className="panel-bd">
              <div className="note warn">
                メールが未登録の担当者が {noMail.length} 名います
                （{noMail.slice(0, 3).map((s) => s.name).join("・")}
                {noMail.length > 3 ? " ほか" : ""}）。
                検収書の連絡先が空欄のまま出ます。
              </div>
            </div>
          )}
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>コード</th><th>氏名</th><th>部門</th><th>メール</th><th>電話</th>
                <th>状態</th><th></th>
              </tr></thead>
              <tbody>
                {staff.map((s) => (
                  <StaffRow key={s.id} row={s} onSaved={reload} />
                ))}
                {!staff.length && <tr><td colSpan={7} className="faint">担当者がいません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="panel">
            <div className="panel-hd">
              <h2>一覧</h2>
              <ListSearch value={keyword} onChange={setKeyword}
                placeholder="名称・カナ・別名" label="取引先を絞り込む" />
            </div>
            <ListCount shown={shown.length} keyword={query} total={total}
                       onClear={() => { setKeyword(""); setKindFilter("all"); }}>
              <span className="filters">
                {(["all", "corporate", "individual"] as const).map((value) => (
                  <button key={value} className="chip" aria-pressed={kindFilter === value}
                          onClick={() => setKindFilter(value)}>
                    {value === "all" ? "すべて" : PARTY_KIND_LABEL[value]}
                  </button>
                ))}
              </span>
            </ListCount>
            <div className="tablewrap">
              <table>
                <thead><tr><th>コード</th><th>名称</th><th>区分</th><th>源泉</th><th>状態</th></tr></thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id} className={p.id === selected ? "sel" : ""} tabIndex={0}
                        aria-selected={p.id === selected}
                        onClick={() => setSelected(p.id)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(p.id); } }}>
                      <td className="code">{p.partyCode ?? `#${p.id}`}</td>
                      <td className={p.status === "merged" ? "faint" : ""}>{p.name}</td>
                      <td>{PARTY_KIND_LABEL[p.kind] ?? p.kind}</td>
                      <td>{p.withholding ? <span className="tag warn">あり</span> : "—"}</td>
                      <td>{p.status === "merged"
                        ? <span className="tag out">#{p.mergedIntoId} へ統合</span>
                        : <StatusTag kind="party" value={p.status} />}</td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr><td colSpan={5} className="faint">
                      {query.trim() ? `「${query}」に一致する取引先はありません` : "取引先がありません"}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <ListLimit shown={parties.length} />
          </div>

          <div className="stack">
            {detail && (
              <>
                <div className="panel">
                  <div className="panel-hd">
                    <h2 className="code">{detail.partyCode ?? `#${detail.id}`}</h2>
                    <span>{detail.name}</span>
                    <span className="tag">{PARTY_KIND_LABEL[detail.kind] ?? detail.kind}</span>
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

                {/* 相手先からも契約と条件明細へ辿れるようにする。 */}
                <Relations kind="party" id={detail.id} onOpen={onOpen} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 担当者1行。押したところだけ直せるようにする。
 *
 * 検収書の【ご連絡先】は部署・氏名・メールをそのまま差すので、ここが空だと
 * 「5営業日以内に下記へご連絡ください」と書いてあるのに宛先の無い紙になる。
 * 移行で入れたきり直す経路が無かったので、一覧から直せるようにした。
 */
function StaffRow({ row, onSaved }: { row: Staff; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() { setDraft(row); setError(null); setEditing(true); }

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.patch(`/staff/${row.id}`, {
        name: draft.name, email: draft.email, department: draft.department,
        phone: draft.phone, status: draft.status
      });
      setEditing(false);
      onSaved();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <tr>
        <td className="code">{row.staffCode ?? `#${row.id}`}</td>
        <td>{row.name}</td>
        <td>{row.department ?? "—"}</td>
        {/* 空欄は薄い「—」ではなく、欠けとして見せる。書類に出る項目なので。 */}
        <td className={row.email ? "faint" : ""}>
          {row.email ?? <span className="tag out">未登録</span>}
        </td>
        <td className="faint">{row.phone ?? "—"}</td>
        <td><StatusTag kind="staff" value={row.status} /></td>
        <td><button className="btn btn-sm" onClick={start}>直す</button></td>
      </tr>
    );
  }

  const cell = (key: "name" | "email" | "department" | "phone", placeholder?: string) => (
    <td>
      <input value={draft[key] ?? ""} placeholder={placeholder} disabled={busy}
             onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </td>
  );

  return (
    <tr className="sel">
      <td className="code">{row.staffCode ?? `#${row.id}`}</td>
      {cell("name")}
      {cell("department", "ボードゲーム事業部")}
      {cell("email", "asai@example.co.jp")}
      {cell("phone", "03-0000-0000")}
      <td>
        <select value={draft.status} disabled={busy}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
          <option value="active">在籍</option>
          <option value="retired">退職</option>
        </select>
      </td>
      <td className="row">
        <button className="btn btn-sm primary" onClick={() => void save()} disabled={busy}>
          保存
        </button>
        <button className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>
          やめる
        </button>
        {error && <span className="faint">{error}</span>}
      </td>
    </tr>
  );
}
