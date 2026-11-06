import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { Modal } from "./Modal.js";
import { AgreementCreate } from "./AgreementsWorkspace.js";
import { SignAfterField, SignNext, signDocOf, useSignReady, type SignDoc } from "./SignNext.js";
import type { AgreementRow } from "../server/agreements/service.js";
import type { DocumentSummary } from "../server/documents/repository.js";
import type { GridRow } from "../server/matters/grid.js";

/**
 * 工程表の「基本契約」「発注書・利用許諾条件書」の段から開くポップアップ（docs/desk-home.md §4）。
 *
 *   基本契約 … この条件の基本契約を決める。
 *     既存から選ぶ：この取引先・同じ向きの基本契約（単体契約）を選ぶと、条件をその契約に載せる
 *                  （/links/condition/:id/agreement。基本契約の下の個別契約はあとで「個別契約」から）。
 *     新しく登録：契約の登録欄（ファイル・クラウドサインつき）。登録したら条件をその契約に載せる。
 *   個別契約 … 利用許諾は条件書（個別契約）、業務委託は発注書。
 *     既存の文書から選ぶ：番号・件名で探した文書を条件に繋ぐ（利用許諾で基本契約があれば、その下の個別契約にする）。
 *     新しく登録：条件明細から件名・期間を引用する。
 *       利用許諾 … 個別契約（基本契約があればその下 -Snn、無ければ単体契約）を立てて条件を載せ、
 *                  ファイルがあれば同じ番号の文書として取り込む（利用許諾契約書）。
 *       業務委託 … 発注書の文書。ファイルがあれば取り込み、無ければ番号だけ取る（ファイル待ち）。
 *     どちらもファイルを上げたら、そのままクラウドサインの署名者の入力へ進める。
 */
export type ContractDialogMode = "master" | "individual";

const isLicense = (r: GridRow) => r.kind === "license" || r.pricingModel === "rate";
/**
 * 条件がもう個別の契約（基本契約の下の個別契約・単体契約）に載っているなら、その契約。
 * そのときは新しく契約を立てず（立てると条件が今の契約から外れる）、文書だけその契約に足す。
 */
const individualOf = (r: GridRow): number | null => {
  if (!r.agreementId) return null;
  if (!r.contract) return r.agreementId;
  if (r.contract.kind === "standalone") return r.contract.id;
  return r.agreementId !== r.contract.id ? r.agreementId : null;
};
const today = () => new Date().toISOString().slice(0, 10);

interface ConditionDetail { termStart: string | null; termEnd: string | null; work?: { id: number; title: string } | null }

export function ContractDialog({ row, mode, onClose, onDone }: {
  row: GridRow; mode: ContractDialogMode;
  onClose: () => void;
  /** 何かを登録・繋いだ。工程表を読み直す。 */
  onDone: (message: string) => void;
}) {
  const license = isLicense(row);
  const party = row.counterparty;
  const direction = row.direction ?? "in";
  const [tab, setTab] = useState<"pick" | "new">("pick");
  const [error, setError] = useState<string | null>(null);
  /** 登録・繋いだあとにクラウドサインへ進む文書。 */
  const [signing, setSigning] = useState<SignDoc | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const sign = useSignReady(true);

  const finish = (message: string, file?: { id: number; documentNo: string } | null, goSign = false) => {
    if (file && goSign) {
      setDoneMessage(message);
      void signDocOf(file.id, file.documentNo).then(setSigning);
      return;
    }
    onDone(message);
  };

  const what = mode === "master" ? "基本契約" : license ? "個別契約（利用許諾条件書）" : "発注書";
  const title = <>{party?.name ?? ""}　{row.name}　<span className="faint">{what}</span></>;

  if (!party) {
    return <Modal title={title} onClose={onClose}><div className="alert">この条件には相手先がありません。条件明細の画面で相手先を入れてください。</div></Modal>;
  }

  if (signing) {
    return (
      <Modal wide title={title} onClose={() => onDone(doneMessage ?? "登録しました")}>
        {doneMessage && <div className="note ok" style={{ marginBottom: 8 }}>{doneMessage}。続けてクラウドサインの署名者を入れてください（送らないなら「やめる」）。</div>}
        <SignNext doc={signing} channels={sign.channels} onFinish={() => onDone(doneMessage ?? "登録しました")} />
      </Modal>
    );
  }

  return (
    <Modal wide title={title} onClose={onClose}>
      <div className="chips" role="tablist" style={{ marginBottom: 10 }}>
        <button className="chip" role="tab" aria-pressed={tab === "pick"} onClick={() => { setTab("pick"); setError(null); }}>
          {mode === "master" ? "既存の契約から選ぶ" : "既存の文書から選ぶ"}
        </button>
        <button className="chip" role="tab" aria-pressed={tab === "new"} onClick={() => { setTab("new"); setError(null); }}>
          新しく登録{mode === "individual" ? "（条件明細から引用）" : ""}
        </button>
      </div>
      {error && <div className="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {mode === "master" && tab === "pick" && (
        <MasterPick row={row} partyId={party.id} direction={direction} onError={setError}
          onPicked={(a) => finish(`${row.conditionNo ?? row.name} を ${a.agreementNo ?? `#${a.id}`} に載せました`)} />
      )}
      {mode === "master" && tab === "new" && (
        <AgreementCreate withFile
          preset={{ partyId: party.id, partyName: party.name, kind: "master", domain: license ? "license" : "service", direction }}
          onCancel={onClose}
          onDone={async (id, agreementNo, _then, file, fileError) => {
            try {
              await api.post(`/links/condition/${row.conditionId}/agreement`, { targetId: id });
            } catch (e) {
              setError(`契約 ${agreementNo ?? `#${id}`} は登録しましたが、条件を載せられませんでした（${(e as ApiError).message}）`);
              return;
            }
            const message = `基本契約 ${agreementNo ?? `#${id}`} を登録し、${row.conditionNo ?? row.name} を載せました${fileError ? `（${fileError}）` : ""}`;
            finish(message, file ?? null, Boolean(file?.sign));
          }} />
      )}
      {mode === "individual" && tab === "pick" && (
        <DocumentPick row={row} partyId={party.id} license={license} onError={setError}
          onPicked={(msg) => finish(msg)} />
      )}
      {mode === "individual" && tab === "new" && (
        <IndividualCreate row={row} license={license} canSign={sign.canSign} onError={setError} onCancel={onClose}
          onCreated={(msg, file, goSign) => finish(msg, file, goSign)} />
      )}
    </Modal>
  );
}

/** 既存の基本契約・単体契約（この取引先・同じ向き）から選ぶ。 */
function MasterPick({ row, partyId, direction, onPicked, onError }: {
  row: GridRow; partyId: number; direction: "in" | "out";
  onPicked: (a: AgreementRow) => void; onError: (m: string | null) => void;
}) {
  const [list, setList] = useState<AgreementRow[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    api.get<{ agreements: AgreementRow[] }>(`/agreements?partyId=${partyId}`)
      .then((r) => setList(r.agreements.filter((a) => (a.kind === "master" || a.kind === "standalone") && a.direction === direction && a.status !== "terminated")))
      .catch((e: ApiError) => { onError(e.message); setList([]); });
  }, [partyId, direction]);
  async function pick(a: AgreementRow) {
    setBusy(a.id); onError(null);
    try {
      await api.post(`/links/condition/${row.conditionId}/agreement`, { targetId: a.id });
      onPicked(a);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(null); }
  }
  if (list === null) return <div className="faint">読み込み中…</div>;
  if (!list.length) return <div className="faint">この取引先（{direction === "in" ? "IN" : "OUT"}）の基本契約・単体契約はありません。「新しく登録」から立ててください。</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="faint">選ぶと、この条件をその契約に載せます。基本契約の下の個別契約（条件書）は、あとで「発注書・利用許諾条件書」の段から登録します。</span>
      <table className="compact">
        <thead><tr><th>番号</th><th>件名</th><th>種類</th><th>締結日</th><th /></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              <td className="code">{a.agreementNo ?? `#${a.id}`}</td>
              <td>{a.title}</td>
              <td>{a.kind === "standalone" ? "単体契約" : "基本契約"}</td>
              <td>{a.executedOn ?? <span className="faint">未締結</span>}</td>
              <td><button className="btn btn-sm primary" disabled={busy !== null} onClick={() => void pick(a)}>{busy === a.id ? "載せています…" : "この契約に載せる"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 既存の文書（取り込んだ条件書・発注書など）を番号・件名で探して、この条件に繋ぐ。 */
function DocumentPick({ row, partyId, license, onPicked, onError }: {
  row: GridRow; partyId: number; license: boolean;
  onPicked: (message: string) => void; onError: (m: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const [onlyParty, setOnlyParty] = useState(true);
  const [docs, setDocs] = useState<DocumentSummary[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // 基本契約に直接載っている（個別契約待ち）か、どこにも載っていないときだけ、文書から個別契約を立てる。
  const master = row.contract?.kind === "master" && individualOf(row) === null ? row.contract : null;
  const [underMaster, setUnderMaster] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (onlyParty) qs.set("partyId", String(partyId));
      api.get<{ documents: DocumentSummary[] }>(`/documents?${qs}`)
        .then((r) => setDocs(r.documents.filter((d) => d.status === "issued" || d.status === "draft").slice(0, 40)))
        .catch((e: ApiError) => { onError(e.message); setDocs([]); });
    }, 250);
    return () => clearTimeout(t);
  }, [q, onlyParty, partyId]);

  async function pick(d: DocumentSummary) {
    setBusy(d.id); onError(null);
    try {
      await api.post(`/links/document/${d.id}/conditions`, { targetId: row.conditionId });
      let extra = "";
      // 利用許諾で基本契約があれば、この文書を基本契約の下の個別契約にする（番号は文書のまま。条件もそこへ載る）。
      if (license && master && underMaster) {
        try {
          const r = await api.post<{ agreementNo: string }>(`/agreement-map/documents/${d.id}/agreement`, { as: "supplement", parentId: master.id });
          extra = `・${master.agreementNo ?? "基本契約"} の下の個別契約 ${r.agreementNo} にしました`;
        } catch (e) { extra = `（個別契約にはできませんでした：${(e as ApiError).message}）`; }
      }
      onPicked(`${d.documentNo ?? `#${d.id}`} を ${row.conditionNo ?? row.name} に繋ぎました${extra}`);
    } catch (e) { onError((e as ApiError).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input className="inline-input" style={{ flex: "1 1 320px" }} placeholder="文書番号・件名で探す" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="faint row" style={{ gap: 4 }}>
          <input type="checkbox" checked={onlyParty} onChange={(e) => setOnlyParty(e.target.checked)} />この取引先の文書だけ
        </label>
        {license && master && (
          <label className="faint row" style={{ gap: 4 }}>
            <input type="checkbox" checked={underMaster} onChange={(e) => setUnderMaster(e.target.checked)} />
            {master.agreementNo ?? "基本契約"} の下の個別契約にする
          </label>
        )}
      </div>
      <span className="faint">
        {license
          ? "条件書として数えるのは、利用許諾条件書（ひな形）か、種別が「利用許諾契約書」「覚書」の取り込み文書です"
          : "発注書として数えるのは、発注書（ひな形）か、種別が「発注書」の取り込み文書です"}
      </span>
      {docs === null ? <div className="faint">読み込み中…</div> : (
        <table className="compact">
          <thead><tr><th>文書番号</th><th>種別・件名</th><th>相手先</th><th>状態</th><th /></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="code">{d.documentNo ?? `#${d.id}`}</td>
                <td>{d.templateLabel ?? ""}{d.title ? <div className="faint">{d.title}</div> : null}</td>
                <td>{d.counterparty ?? "—"}</td>
                <td>{d.status === "issued" ? "決定済み" : "下書き"}</td>
                <td><button className="btn btn-sm primary" disabled={busy !== null} onClick={() => void pick(d)}>{busy === d.id ? "繋いでいます…" : "この条件に繋ぐ"}</button></td>
              </tr>
            ))}
            {!docs.length && <tr><td colSpan={5} className="faint">当たる文書はありません。「新しく登録」から上げてください。</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 条件明細から引用して、個別契約（利用許諾）か発注書（業務委託）を新しく登録する。 */
function IndividualCreate({ row, license, canSign, onCreated, onError, onCancel }: {
  row: GridRow; license: boolean; canSign: boolean;
  onCreated: (message: string, file: { id: number; documentNo: string } | null, goSign: boolean) => void;
  onError: (m: string | null) => void; onCancel: () => void;
}) {
  const master = row.contract?.kind === "master" ? row.contract : null;
  /** もう載っている個別の契約（あればそこへ文書だけ足す）。 */
  const current = individualOf(row);
  const [detail, setDetail] = useState<ConditionDetail | null>(null);
  const [title, setTitle] = useState("");
  const [executedOn, setExecutedOn] = useState("");
  const [unsigned, setUnsigned] = useState(true);
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [signAfter, setSignAfter] = useState(true);
  const [busy, setBusy] = useState(false);

  // 条件明細から引用する：件名（作品・条件名）・期間。
  useEffect(() => {
    api.get<ConditionDetail>(`/conditions/${row.conditionId}`).then((d) => {
      setDetail(d);
      const work = d.work?.title ?? row.workTitle ?? null;
      setTitle(license
        ? `個別利用許諾条件書（${[work, row.name].filter(Boolean).join("・")}）`
        : `発注書（${[work, row.name].filter(Boolean).join("・")}）`);
      setEffectiveOn(d.termStart ?? "");
      setExpiresOn(d.termEnd ?? "");
    }).catch(() => {
      setDetail({ termStart: null, termEnd: null });
      setTitle(license ? `個別利用許諾条件書（${row.name}）` : `発注書（${row.name}）`);
    });
  }, [row.conditionId]);

  const goSign = Boolean(file) && canSign && signAfter;
  const ready = title.trim() && (unsigned || executedOn) && (!(license && current) || Boolean(file));

  async function upload(agreementId: number | null, kind: string, sameNo: boolean) {
    if (!file) return null;
    const params = new URLSearchParams({ title: title.trim(), documentKind: kind, filename: file.name, inbound: "0", conditionIds: String(row.conditionId) });
    if (agreementId) params.set("agreementId", String(agreementId));
    if (sameNo) params.set("sameNoAsAgreement", "1");
    if (!unsigned && executedOn) params.set("receivedOn", executedOn);
    return api.postRaw<{ id: number; documentNo: string }>(`/documents/import?${params}`, file, file.type || "application/pdf");
  }

  async function submit() {
    setBusy(true); onError(null);
    try {
      if (license && current) {
        // もう個別の契約に載っている：契約は立てず、条件書の文書だけその契約に足す（番号は契約番号）。
        const doc = await upload(current, "利用許諾契約書", true);
        onCreated(`条件書 ${doc!.documentNo} を登録しました（今の契約に足しました）`, doc, goSign);
      } else if (license) {
        // 個別契約：基本契約があればその下（番号は 親-Snn）、無ければ単体契約。条件をそこへ載せる。
        const made = await api.post<{ id: number; agreementNo: string | null }>("/agreements", {
          counterpartyId: row.counterparty!.id, direction: row.direction ?? "in",
          kind: master ? "supplement" : "standalone", domain: "license", parentId: master?.id ?? null,
          title: title.trim(), executedOn: unsigned ? null : executedOn, status: unsigned ? "negotiating" : "executed",
          effectiveOn: effectiveOn || (unsigned ? null : executedOn) || null, expiresOn: expiresOn || null
        });
        await api.post(`/links/condition/${row.conditionId}/agreement`, { targetId: made.id });
        const doc = await upload(made.id, "利用許諾契約書", true);
        const no = made.agreementNo ?? `#${made.id}`;
        onCreated(`${master ? "個別契約" : "単体契約"} ${no} を登録し、${row.conditionNo ?? row.name} を載せました${doc ? `（契約書 ${doc.documentNo}）` : "。契約書の PDF はあとで契約の「文書」から上げられます"}`,
          doc, goSign);
      } else if (file) {
        // 発注書：取り込んで条件に繋ぐ（発注書の段に出る）。
        const doc = await upload(null, "発注書", false);
        onCreated(`発注書 ${doc!.documentNo} を登録し、${row.conditionNo ?? row.name} に繋ぎました`, doc, goSign);
      } else {
        // ファイルがまだ無い：番号だけ取る（ファイル待ち。本文に番号を書き込んでから取り込む）。
        const r = await api.post<{ id: number; documentNo: string }>("/documents/reserve", {
          title: title.trim(), documentKind: "発注書", conditionIds: [row.conditionId]
        });
        onCreated(`発注書の番号 ${r.documentNo} を取りました（ファイル待ち。本文に番号を書き込んで、文書の「ファイルを付ける」で登録）`, null, false);
      }
    } catch (e) { onError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  if (!detail) return <div className="faint">条件明細を読んでいます…</div>;
  const year = new Date().getFullYear();
  const numberHint = license
    ? current ? "今の個別契約の番号（契約に載っている条件なので、文書だけ足します）"
    : (master ? `${master.agreementNo ?? "（基本契約）"}-Snn（${master.agreementNo ?? "基本契約"} の下の個別契約）` : `ARC-ILT-${year}-NNNN（基本契約が無いので単体契約）`)
    : file ? `ARC-EPO-${year}-NNNN（取り込んだ発注書）` : `ARC-EPO-${year}-NNNN（番号だけ取る。ファイル待ち）`;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="note">
        条件明細 <span className="code">{row.conditionNo ?? `#${row.conditionId}`}</span>（{row.name}{detail.work?.title ? `・${detail.work.title}` : ""}）から引用しています。
        番号は <span className="code">{numberHint}</span>
      </div>
      <div className="form-grid">
        <label className="field" style={{ gridColumn: "1 / -1" }}><span>件名</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        {license && !current && (<>
          <label className="field"><span>締結日</span>
            <input type="date" value={unsigned ? "" : executedOn} disabled={unsigned} onChange={(e) => setExecutedOn(e.target.value)} />
            <label className="row" style={{ gap: 4, marginTop: 4 }}>
              <input type="checkbox" checked={unsigned} onChange={(e) => { setUnsigned(e.target.checked); if (!e.target.checked && !executedOn) setExecutedOn(today()); }} />
              <small>まだ締結していない（これから送る）</small>
            </label></label>
          <label className="field"><span>有効期間（条件明細の期間）</span>
            <span className="row" style={{ gap: 6 }}>
              <input type="date" value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} />
              <span className="faint">〜</span>
              <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
            </span></label>
        </>)}
        <label className="field" style={{ gridColumn: "1 / -1" }}><span>{license ? "条件書のファイル（PDF）" : "発注書のファイル（PDF）"}</span>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <small className="faint">{license ? (current ? "この条件が載っている契約に足す PDF（必須）。条件の「利用許諾条件書」の段に出ます"
              : "上げると契約と同じ番号の文書になり、条件の「利用許諾条件書」の段に出ます。無ければ契約（番号）だけ立てます")
            : "上げると条件の「発注書」の段に出ます。無ければ番号だけ取ります（本文に書き込んでから取り込む）"}</small>
        </label>
      </div>
      {file && canSign && <SignAfterField checked={signAfter} onChange={setSignAfter} />}
      <div className="row">
        <button className="btn primary" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "登録しています…" : goSign ? "登録して、クラウドサインへ進む" : license ? "個別契約を登録する" : file ? "発注書を登録する" : "番号だけ取る"}
        </button>
        <button className="btn" onClick={onCancel}>やめる</button>
      </div>
    </div>
  );
}
