import { useEffect, useState } from "react";
import type { MatterDetail, MatterKind } from "../server/core/model.js";
import { api, ApiError } from "./api.js";
import { ListSearch, useDebounced } from "./ListTools.js";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import { WorkChooser, type WorkOption } from "./WorkChooser.js";
import { DocumentImport } from "./DocumentImport.js";
import { CONDITION_KIND_LABEL, MATTER_KIND_LABEL, StatusTag } from "./labels.js";

/**
 * 案件に条件と文書を繋ぐ操作。
 *
 * これまで案件の条件タブ・文書タブは読むだけで、繋ぐ手段が画面にもサーバにも
 * 無かった（読む処理は3箇所あった）。そのため案件を開いても中身が空のままで、
 * 「案件を進める」という操作が成立していなかった。
 *
 * 案件は所有せず参照する。繋いでも条件は書き換わらないし、外しても消えない。
 */

interface CandidateCondition {
  id: number; conditionNo: string | null; name: string;
  direction: string; kind: string; counterparty: { name: string } | null;
}
interface CandidateDocument {
  id: number; documentNo: string | null; templateLabel: string | null;
  status: string; counterparty: string | null;
}

export function MatterConditions(
  { detail, onChanged, onOpenCondition }:
  { detail: MatterDetail; onChanged: () => void; onOpenCondition: (id: number) => void }
) {
  const [making, setMaking] = useState(false);
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateCondition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<number | null>(null);
  const [work, setWork] = useState<WorkOption | null>(null);

  const allowed = ALLOWED_KINDS[detail.kind] ?? [];
  const linked = new Set(detail.conditions.map((c) => c.id));

  // ライセンスは作品が軸。作品ひとつに、取引モデルの違う条件（自社製造・自社販売、
  // 再許諾…）が何本も並ぶ。だから作品を先に決め、条件はそこから1本ずつ作る。
  const licensing = detail.kind === "work";
  // 2本目以降は、1本目が知っていることを引き継ぐ。作品・相手先・契約・通貨を
  // 毎回入れ直させると、同じ作品の条件が別々の契約にぶら下がって食い違う。
  const last = detail.conditions[detail.conditions.length - 1] ?? null;

  useEffect(() => {
    if (work) return;
    const first = detail.conditions.map((c) => c.work).find(Boolean);
    if (first) setWork({ id: first.id, title: first.title, workCode: first.workCode });
  }, [detail.conditions]);

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    api.get<{ conditions: CandidateCondition[] }>(`/conditions${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.conditions.filter((c) => allowed.includes(c.kind)).slice(0, 30)))
      .catch(() => setCandidates([]));
  }, [picking, search]);

  async function attach(conditionId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/conditions`, { conditionId });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(conditionId: number, label: string) {
    if (!confirm(`${label} の紐づけを外します。条件そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/conditions/${conditionId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  // 作った条件はそのまま案件に繋ぐ。作って終わりだと、結局あとで繋ぐ手が要る。
  if (!allowed.length) {
    return (
      <div className="note">
        {MATTER_KIND_LABEL[detail.kind]}モデルの案件は条件を持ちません。
        条件が要るなら、取引モデルを変えてください。
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">
          {MATTER_KIND_LABEL[detail.kind]}モデルの案件に繋げるのは
          <b>{allowed.map((k) => CONDITION_KIND_LABEL[k] ?? k).join("・")}</b> の条件です
        </span>
        {!picking && !making && (
          <span className="row" style={{ marginLeft: "auto" }}>
            {/* 案件を見ながら新しい条件を作れるようにする。以前は「条件の画面で
                作ってください」と案内していて、作ってから案件へ戻って繋ぎ直す
                往復が要った。 */}
            <button className="btn btn-sm primary" disabled={licensing && !work}
                    onClick={() => { setMade(null); setMaking(true); }}>
              {licensing ? "この作品で条件を1本作る" : "新しい条件を作る"}
            </button>
            <button className="btn btn-sm"
                    onClick={() => setPicking(true)}>すでにある条件を繋ぐ</button>
          </span>
        )}
      </div>

      {/* 作品を決める段。ライセンスの工程1「権利の上限確認」はここが済む
          ことで済になる。作品が決まらないまま条件を作ると、作品から辿れず、
          許諾できる上限も計算できない条件ができる。 */}
      {licensing && !making && (
        <div className="stack" style={{ gap: 6 }}>
          <WorkChooser value={work} onChange={(w) => { setWork(w); setMade(null); }} disabled={busy} />
          <span className="faint">
            {work
              ? `「${work.title}」の条件をここから1本ずつ作ります。取引モデル（自社製造・自社販売／再許諾…）ごとに1本です`
              : "先に作品を決めてください。作品が決まらないと、許諾できる上限が計算できません"}
          </span>
        </div>
      )}

      {/* 作ったあとの行き先。続けて次の1本を作るのが普通なので、その場に置く。 */}
      {made !== null && !making && (
        <div className="done-note">
          条件を作って、この案件に繋ぎました。
          <span className="row">
            <button className="btn btn-sm primary" onClick={() => { setMade(null); setMaking(true); }}>
              続けてもう1本作る
            </button>
            <button className="btn btn-sm" onClick={() => onOpenCondition(made)}>作った条件を開く</button>
            <button className="btn btn-sm" onClick={() => setMade(null)}>閉じる</button>
          </span>
        </div>
      )}

      {making && (
        <ConditionCreateForm
          title={work
            ? `「${work.title}」の条件を1本作る`
            : `${detail.matterNo ?? "この案件"} に新しい条件を作る`}
          // 案件と、すでに作った条件が知っていることは入れておく。人が入れるのは
          // その条件だけの中身（取引モデルの名前と金額）になる。
          preset={{
            kind: (last?.kind as string | undefined) ?? allowed[0],
            ...(detail.counterparty
              ? { counterpartyId: String(detail.counterparty.id) }
              : last?.counterparty ? { counterpartyId: String(last.counterparty.id) } : {}),
            // 業務委託は必ず自社が払う側。ライセンスは取得も許諾もあるので、
            // 1本目に合わせる（同じ作品の許諾が IN と OUT に散らばらない）。
            ...(detail.kind === "outsourcing" ? { direction: "in" }
              : last ? { direction: last.direction } : {}),
            ...(work ? { workId: String(work.id) } : {}),
            ...(last?.agreement ? { agreementId: String(last.agreement.id) } : {}),
            ...(last ? { currency: last.currency } : {})
          }}
          onDone={(created) => { setMaking(false); setMade(created.id); void attach(created.id); }}
          onCancel={() => setMaking(false)} />
      )}

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="条件名・条件番号・相手先" label="繋ぐ条件を探す" />
            <button className="btn btn-sm" onClick={() => { setPicking(false); setKeyword(""); }}>やめる</button>
          </div>
          <div className="picker">
            {candidates.map((c) => (
              <button key={c.id} className="btn btn-sm" style={{ textAlign: "left" }}
                      disabled={busy || linked.has(c.id)}
                      onClick={() => void attach(c.id)}>
                <span className="code">{c.conditionNo ?? `#${c.id}`}</span>
                {" "}{CONDITION_KIND_LABEL[c.kind] ?? c.kind} / {c.name}
                {c.counterparty ? `（${c.counterparty.name}）` : ""}
                {linked.has(c.id) ? "　繋がっています" : ""}
              </button>
            ))}
            {!candidates.length && (
              <span className="faint">
                繋げる条件がありません。{search.trim() ? "別の言葉で探すか、" : ""}
                条件の画面で先に作ってください
              </span>
            )}
          </div>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {detail.conditions.length ? (
        <table>
          <thead><tr><th>条件番号</th><th>種類</th><th>向き</th><th>内容</th><th></th></tr></thead>
          <tbody>
            {detail.conditions.map((c) => (
              <tr key={c.id}>
                <td className="code">
                  <button className="btn btn-sm" onClick={() => onOpenCondition(c.id)}>
                    {c.conditionNo ?? `#${c.id}`}
                  </button>
                </td>
                <td><span className="tag">{CONDITION_KIND_LABEL[c.kind] ?? c.kind}</span></td>
                <td><span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span></td>
                <td>{c.name}</td>
                <td>
                  <button className="btn btn-sm" disabled={busy}
                    onClick={() => void detach(c.id, c.conditionNo ?? `#${c.id}`)}>外す</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">
          まだ条件が繋がっていません。「条件を繋ぐ」から選ぶか、条件の画面で作ってください。
        </div>
      )}
    </div>
  );
}

export function MatterDocuments(
  { detail, onChanged, onOpenDocument, onCompose }: {
    detail: MatterDetail;
    onChanged: () => void;
    /** 文書の画面へ移って、その文書を開く。 */
    onOpenDocument?: (documentId: number) => void;
    /** 文書の画面へ移って、この案件の条件を選んだ状態で作成に入る。 */
    onCompose?: (conditionIds: number[], eventIds?: number[], matterId?: number | null) => void;
  }
) {
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [candidates, setCandidates] = useState<CandidateDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linked = new Set(detail.documents.map((d) => d.id));

  useEffect(() => {
    if (!picking) return;
    const q = search.trim();
    api.get<{ documents: CandidateDocument[] }>(`/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`)
      .then((r) => setCandidates(r.documents.slice(0, 30))).catch(() => setCandidates([]));
  }, [picking, search]);

  async function attach(documentId: number) {
    setBusy(true); setError(null);
    try {
      await api.post(`/matters/${detail.id}/documents`, { documentId });
      setPicking(false); setKeyword(""); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function detach(documentId: number, label: string) {
    if (!confirm(`${label} をこの案件から外します。文書そのものは消えません。`)) return;
    setBusy(true); setError(null);
    try {
      await api.del(`/matters/${detail.id}/documents/${documentId}`);
      onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="row">
        <span className="faint">この案件の文書</span>
        {/*
          作る導線をここに置く。以前は「発行は文書の画面から行います」と書いて
          あるだけで、文書の画面へ行ってから条件を選び直す必要があった。
          この案件の条件を選んだ状態で作成に入る。
        */}
        {onCompose && !picking && (
          detail.conditions.length ? (
            <span className="row" style={{ marginLeft: "auto" }}>
              <span className="faint">検収書は条件をまたいで実績を選べます（委託料と実費を1枚に）</span>
              <button className="btn btn-sm primary"
                      onClick={() => onCompose(detail.conditions.map((c) => c.id), [], detail.id)}>
                この案件で文書を作る
              </button>
            </span>
          ) : (
            <span className="faint" style={{ marginLeft: "auto" }}>
              条件明細を繋ぐと、ここから文書を作れます
            </span>
          )
        )}
        {!picking && (
          <button className="btn btn-sm"
                  onClick={() => setPicking(true)}>すでにある文書を繋ぐ</button>
        )}
      </div>

      {/* 他社文書レビュー型の案件は、相手方から届いた文書を入れないと先へ進めない。 */}
      <DocumentImport matterId={detail.id} onDone={onChanged} />

      {picking && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <ListSearch value={keyword} onChange={setKeyword}
              placeholder="文書番号・相手先" label="繋ぐ文書を探す" />
            <button className="btn btn-sm" onClick={() => { setPicking(false); setKeyword(""); }}>やめる</button>
          </div>
          <div className="picker">
            {candidates.map((d) => (
              <button key={d.id} className="btn btn-sm" style={{ textAlign: "left" }}
                      disabled={busy || linked.has(d.id)} onClick={() => void attach(d.id)}>
                <span className="code">{d.documentNo ?? "（下書き）"}</span>
                {" "}{d.templateLabel ?? "—"}{d.counterparty ? `（${d.counterparty}）` : ""}
                {linked.has(d.id) ? "　繋がっています" : ""}
              </button>
            ))}
            {!candidates.length && <span className="faint">繋げる文書がありません</span>}
          </div>
        </div>
      )}

      {error && <div className="alert">{error}</div>}

      {detail.documents.length ? (
        <table>
          <thead><tr><th>文書番号</th><th>種別</th><th>状態</th><th></th></tr></thead>
          <tbody>
            {detail.documents.map((d) => (
              <tr key={d.id}>
                <td className="code">{d.documentNo ?? "（下書き）"}</td>
                <td>{d.templateLabel ?? "—"}</td>
                <td><StatusTag kind="document" value={d.status} /></td>
                <td>
                  <span className="row">
                    {/* 一覧から中身へ行けないと、文書番号を控えて文書の画面で
                        探し直すことになる。 */}
                    {onOpenDocument && (
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => onOpenDocument(d.id)}>
                        {d.status === "draft" ? "編集" : "開く"}
                      </button>
                    )}
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => void detach(d.id, d.documentNo ?? `#${d.id}`)}>外す</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="faint">この案件の文書はまだありません。</div>
      )}
    </div>
  );
}

/** 取引モデルごとに繋げる条件の種類。サーバの CONDITION_KINDS_BY_MATTER と対。 */
const ALLOWED_KINDS: Record<MatterKind, string[]> = {
  work: ["license", "product"],
  outsourcing: ["service", "expense", "fee"],
  // 文書作成でも金銭の条件を持つ文書はある（自社のひな形から出す覚書など）。
  // サーバ側の CONDITION_KINDS_BY_MATTER と同じ並びにしておくこと。
  single: ["license", "product", "service", "expense", "fee"]
};
