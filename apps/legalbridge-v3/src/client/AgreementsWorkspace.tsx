import { useEffect, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { ListCount, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag } from "./labels.js";
import { Relations, type EntityKind } from "./Relations.js";

/**
 * 契約（合意）。
 *
 * 条件は契約の明細であって、それ自体が契約書ではない。器である契約に画面が
 * 無かったので、条件が独立した書類のように見えていた（番号があり、状態があり、
 * 改訂があるので、なおさら）。ここで器を出して、条件をその中の行として見せる。
 *
 * 金額や料率を持つのは条件のほう。期間と更新は契約が持つ。契約は続いたまま
 * 金額だけ改定されるので、この分け方でないと改訂のたびに契約が増える。
 */

interface AgreementRow {
  id: number; agreementNo: string | null; title: string; direction: "in" | "out";
  status: string; executedOn: string | null; effectiveOn: string | null; expiresOn: string | null;
  counterparty: { id: number; name: string };
  conditionCount: number; documentCount: number; totalFlat: number;
}

interface LineRow {
  id: number; conditionNo: string | null; name: string; kind: string; status: string;
  direction: string; currency: string; pricingModel: string;
  ratePct: number | null; flatAmount: number | null;
  mgAmount: number | null; agAmount: number | null;
  termStart: string | null; termEnd: string | null; effectiveFrom: string | null;
  /** どの作品の条件か。基本契約は複数の作品に及ぶ。 */
  work: { id: number; code: string | null; title: string; part: string | null } | null;
}

interface WorkRow {
  id: number; code: string | null; title: string;
  conditionCount: number; activeCount: number;
}

interface Detail {
  agreement: AgreementRow & {
    autoRenewal: boolean; renewalNoticeMonths: number | null; sourceUrl: string | null;
  };
  conditions: LineRow[];
  /** この契約が及ぶ作品。条件をまとめ直したもの。 */
  works: WorkRow[];
}

const KIND_LABEL: Record<string, string> = {
  license: "許諾料", product: "製品", service: "委託料", expense: "実費", fee: "手数料"
};

/** その明細が何でいくらか、を1行で書く。表の列を増やすより読みやすい。 */
function terms(line: LineRow): string {
  const parts: string[] = [];
  if (line.ratePct !== null) parts.push(`料率 ${line.ratePct}%`);
  if (line.flatAmount) parts.push(`定額 ${money(line.flatAmount, line.currency)}`);
  if (line.mgAmount) parts.push(`MG ${money(line.mgAmount, line.currency)}`);
  if (line.agAmount) parts.push(`AG ${money(line.agAmount, line.currency)}`);
  return parts.join("／") || "—";
}

export function AgreementsWorkspace(
  { initialId, onOpen }: { initialId?: number; onOpen?: (kind: EntityKind, id: number) => void }
) {
  const [rows, setRows] = useState<AgreementRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [selected, setSelected] = useState<number | undefined>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.get<{ agreements: AgreementRow[] }>(
      `/agreements${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`)
      .then((r) => setRows(r.agreements))
      .catch((e: ApiError) => setError(e.message));
  }, [search, version]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    api.get<Detail>(`/agreements/${selected}`)
      .then(setDetail).catch((e: ApiError) => setError(e.message));
  }, [selected, version]);

  return (
    <section className="workspace">
      <header className="workspace-head">
        <h1>契約</h1>
        <p>
          契約は器。期間と更新は契約が持ち、金額と料率は中の条件明細が持ちます。
          契約は続いたまま金額だけ改定されるので、改定しても契約は増えません。
        </p>
      </header>

      {error && <div className="alert">{error}</div>}

      <div className="stack">
        <div className="panel">
          <div className="panel-hd">
            <h2>契約</h2>
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="契約番号・件名・相手先" label="契約を絞り込む" />
          </div>
          <ListCount shown={rows.length} keyword={search} onClear={() => setKeyword("")} />
          <div className="tablewrap">
            <table>
              <thead><tr>
                <th>契約番号</th><th>件名</th><th>相手先</th>
                <th className="num">条件明細</th><th className="num">文書</th>
                <th>期間</th><th>状態</th>
              </tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className={a.id === selected ? "on" : undefined}
                      onClick={() => setSelected(a.id)} style={{ cursor: "pointer" }}>
                    <td className="code">
                      <span className={`tag ${a.direction}`}>{a.direction === "in" ? "IN" : "OUT"}</span>
                      {" "}{a.agreementNo ?? `#${a.id}`}
                    </td>
                    <td>{a.title}</td>
                    <td>{a.counterparty.name}</td>
                    <td className="num">{a.conditionCount}</td>
                    <td className="num">{a.documentCount}</td>
                    <td className="faint">
                      {a.effectiveOn ?? a.executedOn ?? "—"}
                      {a.expiresOn ? ` 〜 ${a.expiresOn}` : " 〜 期限なし"}
                    </td>
                    <td><StatusTag kind="agreement" value={a.status} /></td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={7} className="faint">
                    {search.trim() ? `「${search}」に一致する契約はありません` : "契約がありません"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {detail && (
          <>
            <div className="panel">
              <div className="panel-hd">
                <h2>{detail.agreement.agreementNo ?? `#${detail.agreement.id}`} {detail.agreement.title}</h2>
                <span className="faint" style={{ marginLeft: "auto" }}>
                  {detail.agreement.counterparty.name}
                </span>
              </div>
              <div className="panel-bd stack">
                <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
                  <span><span className="faint">締結 </span>{detail.agreement.executedOn ?? "—"}</span>
                  <span><span className="faint">発効 </span>{detail.agreement.effectiveOn ?? "—"}</span>
                  <span><span className="faint">満了 </span>{detail.agreement.expiresOn ?? "期限なし"}</span>
                  <span><span className="faint">自動更新 </span>
                    {detail.agreement.autoRenewal
                      ? `あり${detail.agreement.renewalNoticeMonths ? `（${detail.agreement.renewalNoticeMonths}か月前通知）` : ""}`
                      : "なし"}</span>
                </div>
              </div>
            </div>

            {detail.works.length > 0 && (
              <div className="panel">
                <div className="panel-hd">
                  <h2>及ぶ作品 {detail.works.length}</h2>
                  <span className="faint">
                    契約は作品を直接持ちません。条件明細がどの作品を指しているかで決まります
                  </span>
                </div>
                <div className="panel-bd">
                  <div className="chips">
                    {detail.works.map((w) => (
                      <button key={w.id} type="button" className="tag accent"
                              onClick={() => onOpen?.("work", w.id)}
                              title={w.code ?? undefined}>
                        {w.title}
                        <span className="faint" style={{ marginLeft: 4 }}>
                          条件 {w.activeCount}
                          {w.conditionCount !== w.activeCount && `／${w.conditionCount}`}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-hd">
                <h2>条件明細</h2>
                <span className="faint">
                  この契約の中身。金額と料率はここが持ちます（契約そのものは持ちません）
                </span>
              </div>
              <div className="tablewrap">
                <table>
                  <thead><tr>
                    <th>番号</th><th>作品</th><th>名称</th><th>種類</th><th>条件</th>
                    <th>期間</th><th>適用開始</th><th>状態</th><th></th>
                  </tr></thead>
                  <tbody>
                    {detail.conditions.map((line) => (
                      <tr key={line.id}>
                        <td className="code">{line.conditionNo ?? `#${line.id}`}</td>
                        <td>
                          {line.work ? (
                            <>
                              {line.work.title}
                              {line.work.part && (
                                <span className="faint" style={{ marginLeft: 4 }}>{line.work.part}</span>
                              )}
                            </>
                          ) : <span className="faint">作品なし</span>}
                        </td>
                        <td>{line.name}</td>
                        <td>{KIND_LABEL[line.kind] ?? line.kind}</td>
                        <td className="faint">{terms(line)}</td>
                        <td className="faint">
                          {line.termStart ?? "—"}{line.termEnd ? ` 〜 ${line.termEnd}` : " 〜 期限なし"}
                        </td>
                        <td className="faint">{line.effectiveFrom ?? "—"}</td>
                        <td><StatusTag kind="condition" value={line.status} /></td>
                        <td>
                          {onOpen && (
                            <button className="btn btn-sm"
                                    onClick={() => onOpen("condition", line.id)}>開く</button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!detail.conditions.length && (
                      <tr><td colSpan={9} className="faint">
                        この契約にはまだ条件明細がありません。下の「つながり」から繋げます。
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <Relations kind="agreement" id={detail.agreement.id} reloadKey={version}
              onOpen={onOpen} onChanged={() => setVersion((v) => v + 1)} />
          </>
        )}
      </div>
    </section>
  );
}
