import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ListCount, ListLimit, ListSearch, useDebounced } from "./ListTools.js";
import { StatusTag, SettlementTag } from "./labels.js";
import type { ConditionSummary } from "../server/core/model.js";
import { api, ApiError, money } from "./api.js";
import type { EntityKind } from "./Relations.js";
import { DocumentDetail, type DocumentRow } from "./DocumentDetail.js";
import { DetailBack } from "./DetailBack.js";
import { DocumentFields, kindFor, type Candidate, type FormField } from "./DocumentFields.js";
import { LineItemsEditor, type Row } from "./LineItems.js";
import { BulkOrders } from "./BulkOrders.js";
import { SettledImport } from "./SettledImport.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";
import { StatementBreakdown, type StatementLine, type StatementTotals } from "./StatementLines.js";
import { LicenseTermsMatrix } from "./LicenseTermsMatrix.js";
import { ConditionLabel } from "./ConditionLabel.js";
import { BLANK_INPUT_KEY, blankedNames } from "../server/documents/binding.js";
import { PUB_TERMS_TEMPLATE_HINT } from "../server/documents/pub-terms.js";

interface TemplateRow {
  id: number; templateKey: string; label: string; category: string | null; numberPrefix: string | null;
}

/** 一覧を案件で絞るときの選択肢。 */
const searchMattersForList = async (q: string): Promise<SearchOption[]> => {
  const r = await api.get<{ matters: Array<{ id: number; matterNo: string | null; title: string }> }>(
    `/matters?q=${encodeURIComponent(q)}`);
  return r.matters.map((m) => ({ value: String(m.id), label: `${m.matterNo ?? `#${m.id}`} ${m.title}` }));
};

/** 一覧の絞り込み。人が見る段階（下書き → 決定 → 送信）に、繋ぎ直し用の1つを足す。 */
const SCOPES = [
  ["all", "すべて"], ["draft", "下書き"], ["decided", "決定済み"], ["sent", "送信済み"],
  ["unlinked", "条件明細なし"]
] as const;
type Scope = (typeof SCOPES)[number][0];
interface Integrations {
  drive: { documents: boolean; matterFolders: boolean };
  channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
}
interface PreviewResponse {
  html: string; templateLabel: string;
  missing: Array<{ name: string; label: string }>; derived: string[];
  values: Record<string, unknown>;
  /** 画面に出す項目。区分と出どころ（計算／自動／手入力）付き。 */
  fields: FormField[];
  /** 入力欄の横に出す候補。押すとその値が入る。 */
  candidates: Candidate[];
  /** 本文が差しているのに空で出る項目。止めはしないが、出す前に見せる。 */
  warnings: Array<{ kind: "bank" | "company" | "staff" | "other"; message: string }>;
  /** 明細の欄と、条件・予定・実績から組んだ種の行。 */
  lines: Array<{ name: string; rows: Row[] }>;
  /** 計算書か。金額の枠（対象期間・実績・試算）を出すかどうか。 */
  statement?: boolean;
}
interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  amount: number; status: string; documentId?: number | null;
  /** どの条件の実績か。条件をまたいで1枚にするので、行に持たせる。 */
  conditionId: number; conditionNo: string | null; conditionName: string;
}

/** 一覧の中の紐づけ。件数ではなく番号を出して、そのまま辿れるようにする。 */
function Refs(
  { doc, onOpen }: { doc: DocumentRow; onOpen?: (kind: EntityKind, id: number) => void }
) {
  const shown = doc.conditions.slice(0, 2);
  const rest = doc.conditions.length - shown.length;
  return (
    <span className="reflist" onClick={(e) => e.stopPropagation()}>
      {shown.length
        ? shown.map((c) => (
            <button key={c.id} className="linky"
                    onClick={() => onOpen?.("condition", c.id)}>
              {c.conditionNo ?? `#${c.id}`}
            </button>
          ))
        : <span className="none">条件明細なし</span>}
      {rest > 0 && <span className="none">ほか {rest} 件</span>}
      {doc.matterId
        ? <button className="linky" onClick={() => onOpen?.("matter", doc.matterId!)}>
            {doc.matterNo ?? `#${doc.matterId}`}
          </button>
        : <span className="none">案件なし</span>}
    </span>
  );
}

export function DocumentsWorkspace(
  { start, openDocumentId, openNonce, onOpen }: {
    start?: { conditionIds: number[]; eventIds: number[]; matterId?: number | null;
              /**
               * 呼んだ側が決めているひな形。計算書のように「何を作るか」が
               * 移る前から決まっている経路で渡す。渡さないと既定（先頭）の
               * ひな形で開き、人がもう一度選び直すことになる。
               */
              templateKey?: string | null;
              /** 案件から「発注書をまとめて作る」で来た。一括作成を開いた状態にする。 */
              bulk?: boolean;
              /** 案件から「検収済みをまとめて入れる」で来た。 */
              settled?: boolean };
    /** 他の画面から「編集」で来たときの文書。下書きならそのままフォームに載せる。 */
    openDocumentId?: number;
    /** 押すたびに増える番号。同じ文書をもう一度開く合図。 */
    openNonce?: number;
    onOpen?: (kind: EntityKind, id: number) => void;
  } = {}
) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const search = useDebounced(keyword);
  const [conditions, setConditions] = useState<ConditionSummary[]>([]);
  /** 支払済み・完了扱いの条件も候補に出すか。既定は出さない。 */
  const [showSettled, setShowSettled] = useState(false);
  const [templateKey, setTemplateKey] = useState("");
  // 条件の画面から来たときは、その条件と実績を選んだ状態で開く。
  const [picked, setPicked] = useState<number[]>(start?.conditionIds ?? []);
  const [manual, setManual] = useState<Record<string, string>>({});
  /**
   * 人が直した明細の行（items / other_fees / expenses / delivery_line_items）。
   * 無い名前は種のまま（サーバが組んだ行が本文になる）。手入力の文字とは
   * 別に持つ。混ぜると「前回の値」に配列まで覚えてしまう。
   */
  const [lines, setLines] = useState<Record<string, Row[]>>({});
  /**
   * ひな形が要求する項目の一覧と候補。**必ず手入力を空にして取る。**
   *
   * 手入力を送ると、埋まった項目は missing から消える。それを入力欄の元に
   * すると、打ち終わった欄が画面から消える。残数は画面の値で数えれば足りる。
   */
  const [spec, setSpec] = useState<PreviewResponse | null>(null);
  /** spec がどのひな形のものか。ひな形を変えた直後は前のひな形の項目が残る。 */
  const [specKey, setSpecKey] = useState("");
  /** プレビューの本文。入力欄とは別に持つ。打つたびに作り直しても打鍵を邪魔しない。 */
  const [rendered, setRendered] = useState<{ html: string; templateLabel: string } | null>(null);
  /** 直している下書き。作り直した文書はここに載せて、直してから発行する。 */
  const [draft, setDraft] = useState<{ id: number; no: string | null } | null>(null);
  /** 開いている下書きの案件。条件の候補をこの案件のぶんに絞る。 */
  const [draftMatterId, setDraftMatterId] = useState<number | null>(null);
  /**
   * 基本契約（発注書の準拠契約・条件書の基本契約）。null は「選んだ条件に
   * 付いている契約に従う」。条件に契約が無いときや、別の契約に基づくときに選ぶ。
   */
  const [agreementId, setAgreementId] = useState<number | null>(null);
  const [agreements, setAgreements] = useState<Array<{ id: number; agreementNo: string | null; title: string;
    status: string; counterparty: { id: number; name: string } }>>([]);
  /** 案件が決まっているとき、その案件の条件だけを候補に出す（既定）。 */
  const [scopeToMatter, setScopeToMatter] = useState(true);
  /** 差し替え済み（改訂前）の版も候補に出すか。既定は出さない。 */
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [matterConditions, setMatterConditions] = useState<ConditionSummary[] | null>(null);
  /** 一覧で選んでいる文書。右にその文書の詳細を出す。 */
  const [selected, setSelected] = useState<number | null>(null);
  /**
   * 作成中に文書の一覧を開いているか。
   *
   * 作成のフォームは長い（条件書は 24 項目＋2つの表）。その下に全文書の一覧が
   * そのまま続いていて、いま作っているものと関係のない行を延々とスクロール
   * させられていた。作成中は畳んで、必要なら開く。
   */
  const [listWhileComposing, setListWhileComposing] = useState(false);
  /** 旧版を開いている文書。既定は畳む（いまの版だけを読めるようにする）。 */
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set());
  // 決定した結果。番号だけでなく id も持つ（そのまま開けるように）。
  const [issued, setIssued] = useState<{ id: number; documentNo: string } | null>(null);
  // 決定したことに気づかず同じ画面を見続けないよう、結果まで運ぶ。
  const issuedRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [me, setMe] = useState<{ user?: { email: string; role: string } } | null>(null);
  useEffect(() => { api.get<{ user?: { email: string; role: string } }>("/me").then(setMe).catch(() => setMe(null)); }, []);
  const [stored, setStored] = useState<string | null>(null);
  // 呼び出した条件の実績。検収書はここの日付と金額を候補に出す。
  const [events, setEvents] = useState<EventRow[]>([]);
  const [pickedEvents, setPickedEvents] = useState<number[]>(start?.eventIds ?? []);
  const [condSearch, setCondSearch] = useState("");
  // 候補から選んだ欄。手で打った欄だけを「前回の値」として覚える。
  const [pickedFields, setPickedFields] = useState<Set<string>>(new Set());
  const form = useRef<HTMLDivElement>(null);

  /**
   * 一覧の絞り込み。
   *
   * 「条件明細なし」は移行文書の繋ぎ直し用。移行してきた文書はほとんど条件が
   * 付いていない（V1 が持っていなかった）ので、残りを上から目で追うのではなく、
   * まだ繋がっていないものだけを出して片づけられるようにする。
   */
  const [scope, setScope] = useState<Scope>("all");
  // 「つながり」の条件明細の欄を開いた状態で出すか。上の案内から押されたとき。
  const [linkConditions, setLinkConditions] = useState(false);
  /**
   * 作成フォームを出しているか。
   *
   * 以前はページの上半分がいつも作成フォームだった。既にある文書を見に来ても、
   * 案件から「編集」で来ても、最初に目に入るのはテンプレートの選択欄で、
   * いま何を開いているのか分からなかった。作るのは押してから。
   *
   * ただし start があるときは別。条件や実績の画面から「文書を作る」で来た人は、
   * もう作ると決めている。ここで閉じておくと、飛んだ先で何も起きていないように
   * 見える（条件と実績は選ばれているのに、それが隠れたフォームの中にある）。
   */
  // 一括作成・検収済みの取込で来たときは、作成フォームではなくその画面を開く。
  const [composing, setComposing] = useState(Boolean(start) && !start?.bulk && !start?.settled);
  /** 一括作成（CSV）を開いているか。束を作ったら一覧をその束で絞る。 */
  const [bulk, setBulk] = useState(Boolean(start?.bulk));
  /** 検収済みの遡及取込。発注書の一括作成とは別の口（作るものが違う）。 */
  const [settled, setSettled] = useState(Boolean(start?.settled));
  const [batchId, setBatchId] = useState<number | null>(null);
  /**
   * 一覧を案件で絞る。取り込みも作成もこの画面からやるので、上げ直した紙が
   * どれかを見るのに、毎回 200 件の一覧から目で探していた。
   */
  const [listMatter, setListMatter] = useState("");
  const [listMatterLabel, setListMatterLabel] = useState<string | null>(null);

  useEffect(() => { void reload(); }, [search, scope, batchId, listMatter]);

  /**
   * 他の画面から文書を指定して来たとき。
   *
   * 以前は下書きなら作成フォームに載せていた。そのせいで、案件から「編集」を
   * 押しただけでテンプレート選択の画面に飛び、いま何を開いたのか分からなく
   * なっていた。取込文書のようにひな形を持たない文書では、そもそも載らない。
   *
   * 開いたら、まずその文書が何で何に繋がっているかを出す。フォームに載せるのは
   * 「中身を直す」を押したときだけにする。
   */
  useEffect(() => {
    if (!openDocumentId) return;
    setSelected(openDocumentId);
    // openNonce も見る。一覧へ戻ってから同じ文書を開き直すと ID が変わらず、
    // ここが走らないので一覧のままになっていた。
  }, [openDocumentId, openNonce]);

  // 別の文書に移ったら、前の文書で開いた欄は閉じる。
  useEffect(() => { setLinkConditions(false); }, [selected]);

  /**
   * 選んでいた文書が一覧から消えたら、次の1件へ送る。
   *
   * 「条件明細なし」で絞って上から繋いでいくと、繋いだ瞬間にその行は条件が
   * 付いたので一覧から外れる。詳細が黙って空になると、片づけの手が止まる。
   */
  useEffect(() => {
    if (selected === null) return;
    if (documents.some((d) => d.id === selected)) return;
    setSelected(documents[0]?.id ?? null);
  }, [documents]);
  async function reload() {
    try {
      const [t, d, c, i] = await Promise.all([
        api.get<{ templates: TemplateRow[] }>("/document-templates"),
        api.get<{ documents: DocumentRow[] }>(`/documents?${new URLSearchParams({
          ...(search.trim() ? { q: search.trim() } : {}),
          ...(scope === "unlinked" ? { unlinked: "1" } : {}),
          ...(scope === "draft" || scope === "decided" || scope === "sent" ? { phase: scope } : {}),
          ...(batchId ? { batchId: String(batchId) } : {}),
          ...(listMatter ? { matterId: listMatter } : {})
        })}`),
        // 出版の条件書は条件 170 本で1通になる。既定の 200 では台帳の新しい順に
        // 切られて、載せたい条件が候補に出てこない。
        api.get<{ conditions: ConditionSummary[] }>("/conditions?limit=500"),
        api.get<Integrations>("/integrations")
      ]);
      setTemplates(t.templates);
      // 開くよう指定された文書が一覧の 200 件に入っていなければ、単独で引いて先頭に足す。
      // 一覧は下書き・発行日なしが先に並ぶので、決定済みの文書は 200 件から溢れることが
      // あり、溢れると「選んでいた文書が消えたら次へ」で先頭の下書きに飛んでいた。
      let list = d.documents;
      if (openDocumentId && !list.some((x) => x.id === openDocumentId)) {
        const one = await api.get<DocumentRow>(`/documents/${openDocumentId}`).catch(() => null);
        if (one) list = [one, ...list];
      }
      setDocuments(list);
      setConditions(c.conditions);
      setIntegrations(i);
      if (!templateKey) {
        const wanted = start?.templateKey
          && t.templates.some((x) => x.templateKey === start.templateKey)
          ? start.templateKey : null;
        if (wanted ?? t.templates[0]) setTemplateKey(wanted ?? t.templates[0].templateKey);
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }

  /**
   * 選んだ条件の実績を全部呼び出す。条件をまたいで選べる（委託料と実費の
   * 検収を1枚に）。条件を外したら、その条件の実績の選択も外す。
   * 条件の画面から実績を指定して来たときは、その選択を消さない。
   */
  useEffect(() => {
    if (!picked.length) { setEvents([]); setPickedEvents([]); return; }
    let live = true;
    Promise.all(picked.map((id) =>
      api.get<{ events: Array<Omit<EventRow, "conditionId" | "conditionNo" | "conditionName">> }>(`/conditions/${id}/events`)
        .then((r) => {
          const c = conditions.find((x) => x.id === id);
          return r.events.filter((e) => e.status === "active").map((e) => ({
            ...e, conditionId: id, conditionNo: c?.conditionNo ?? null, conditionName: c?.name ?? `#${id}`
          }));
        })
        .catch(() => [] as EventRow[])))
      .then((lists) => {
        if (!live) return;
        const all = lists.flat();
        setEvents(all);
        setPickedEvents((prev) => prev.filter((id) => all.some((e) => e.id === id)));
      });
    return () => { live = false; };
  }, [picked.join(","), conditions.length]);

  /**
   * 版の連鎖。参照は新→旧（supersedes_id）の一方向しか無いので、
   * 一覧の中で辿って組み立てる。
   */
  const byId = useMemo(
    () => new Map(documents.map((d) => [d.id, d])), [documents]);

  /**
   * いまの版だけ。退いた版（訂正版に差し替えられたもの）だけを下に畳む。
   *
   * 「後継がいるか」で畳むと、訂正版の下書きを作った瞬間に、まだ有効な発行済み
   * 文書が一覧から消える。退くのは訂正版を発行したときなので、状態で判断する。
   */
  const heads = useMemo(
    () => documents.filter((d) =>
      // 退いた版でも、畳む先（後継）が一覧に居ないなら独立した行として出す。
      // 絞り込むと後継だけ外れることがあり、件数と行数が合わなくなっていた。
      d.status !== "superseded"
      || !documents.some((x) => x.id === d.supersededById)),
    [documents]);

  /** その版が差し替えた、退いた古い版たち（新しい順）。 */
  const ancestorsOf = (d: DocumentRow): DocumentRow[] => {
    const out: DocumentRow[] = [];
    let id = d.supersedesId;
    while (id !== null && byId.has(id) && out.length < 30) {
      const prev = byId.get(id)!;
      // まだ退いていない版はそれ自体が現行。畳まず、独立した行として見せる。
      if (prev.status !== "superseded") break;
      out.push(prev);
      id = prev.supersedesId;
    }
    return out;
  };

  /** 初版から現行までの並び。履歴に出す。 */
  const chainOf = (d: DocumentRow): DocumentRow[] => {
    const newer: DocumentRow[] = [];
    let id = d.supersededById;
    while (id !== null && byId.has(id) && newer.length < 30) {
      const next = byId.get(id)!;
      newer.push(next);
      id = next.supersededById;
    }
    return [...ancestorsOf(d).reverse(), d, ...newer];
  };

  const current = selected === null ? null : byId.get(selected) ?? null;

  /**
   * 選んだ文書だけ、詳細を引き直して一覧の行に混ぜる。
   *
   * 一覧の行は詳細だけの欄（立っている支払など）を持たない。持たないまま
   * 画面に渡すと「支払は立っていない」と読めてしまい、すでに立っている
   * 支払があってもボタンが出て、押してから断られる。
   *
   * 詳細は一覧の上位互換なので、そのまま上書きしてよい。
   */
  useEffect(() => {
    if (selected === null) return;
    let alive = true;
    api.get<DocumentRow>(`/documents/${selected}`)
      .then((one) => {
        if (!alive || !one) return;
        setDocuments((prev) => prev.map((d) => (d.id === one.id ? { ...d, ...one } : d)));
      })
      .catch(() => { /* 一覧の行のままでも読むぶんには困らない */ });
    return () => { alive = false; };
  }, [selected]);

  /** サーバへ渡す手入力。文字の欄と、直した明細の行を合わせたもの。 */
  const inputs = useMemo(() => ({ ...manual, ...lines }), [manual, lines]);

  // 検収書・納品書は実績1件が明細1行。実績を選ぶ枠を出すかどうかの判断に使う。
  const usesDeliveryLines = (spec?.lines ?? []).some((l) => l.name === "delivery_line_items");
  /**
   * 計算書。ほかのひな形と違って、本文の金額は手入力ではなく実績からの試算で決まる。
   *
   * ここに枠が無かったので、ひな形に「利用許諾料計算書」を選ぶと、条件を選んでも
   * 入力欄が1つも出ないまま「決定する」だけが残っていた（本文が差す金額は
   * 手入力の宣言に無いので、項目一覧にも出てこない）。押せば金額の入っていない
   * 紙が1枚できる。実績を選んで試算し、その試算のまま出す道をここに置く。
   */
  // 判断はサーバが持つ（template-context の isStatementTemplate）。ここで
  // ひな形の名前を並べ直すと、増えたときに片方だけ直して食い違う。
  // ひな形を変えた直後は前のひな形の spec が残っているので、それは使わない。
  const specFresh = specKey === templateKey;
  const isStatement = specFresh && spec?.statement === true;
  // 条件書は明細ではなく2つの表を持つ。名前で見分ける（サーバの seedLines と対）。
  const isLicenseTerms = specFresh
    && (spec?.lines ?? []).some((l) => l.name === "v3_conds");
  const [stmtPeriod, setStmtPeriod] = useState("");
  const [stmt, setStmt] = useState<{ lines: StatementLine[]; totals: StatementTotals } | null>(null);
  const [stmtError, setStmtError] = useState<string | null>(null);
  // 条件ごとに実績をまとめる。計算は条件ごと（料率も MG・AG も条件ごとに違う）で、
  // 1枚にまとめるのは印字と支払のまとめ方だけ。
  const stmtEntries = picked
    .map((cid) => ({
      conditionId: cid,
      eventIds: pickedEvents.filter((id) => events.some((e) => e.id === id && e.conditionId === cid))
    }))
    .filter((e) => e.eventIds.length > 0);
  const stmtKey = stmtEntries.map((e) => `${e.conditionId}:${e.eventIds.join("-")}`).join(",");
  // 選んだのに実績が無い条件。ここが空だと、その条件は1行も出ない。
  const withoutEvents = picked.filter((cid) => !events.some((e) => e.conditionId === cid));
  /** 案件。案件や条件の画面から来たとき、または開いた下書きのもの。無ければサーバが条件から引く。 */
  const matterId = start?.matterId ?? draftMatterId ?? null;

  // 案件が決まっていれば、その案件に紐づく条件だけを候補にする。全社の条件が
  // 並ぶと、同じ名前の別案件の条件や改訂前の版を取り違える。
  useEffect(() => {
    if (!matterId) { setMatterConditions(null); return; }
    let live = true;
    api.get<{ conditions: ConditionSummary[] }>(`/conditions?matterId=${matterId}&limit=500`)
      .then((r) => { if (live) setMatterConditions(r.conditions); })
      .catch(() => { if (live) setMatterConditions(null); });
    return () => { live = false; };
  }, [matterId]);
  const scoped = Boolean(matterId) && scopeToMatter && matterConditions !== null;
  const candidateConditions = (scoped ? matterConditions! : conditions)
    .filter((c) => showSuperseded || picked.includes(c.id) || c.status !== "superseded");
  /** 候補を何行まで描くか。80点の作品を1通に載せるので、押して伸ばせるようにする。 */
  const [shownLimit, setShownLimit] = useState(40);
  /**
   * 絞り込みに当たっている候補。選んだものは、絞り込みに当たらなくても必ず出す
   * （画面から消えると、何を選んだのか分からないまま紙に載る）。
   */
  const matchedConditions = candidateConditions
    .filter((c) => showSettled || picked.includes(c.id) || !c.settlement?.done)
    .filter((c) => {
      const q = condSearch.trim().toLowerCase();
      if (!q) return true;
      return [c.conditionNo, c.name, c.counterparty?.name,
              c.agreement?.title, c.agreement?.agreementNo]
        .some((v) => String(v ?? "").toLowerCase().includes(q));
    });
  const shownConditions = [
    ...matchedConditions.filter((c) => picked.includes(c.id)),
    ...matchedConditions.filter((c) => !picked.includes(c.id)).slice(0, Math.max(0, shownLimit - picked.length))
  ];
  const hiddenConditions = matchedConditions.length - shownConditions.length;
  const supersededCount = (scoped ? matterConditions! : conditions).filter((c) => c.status === "superseded").length;
  const settledCount = (scoped ? matterConditions! : conditions).filter((c) => c.settlement?.done).length;
  /**
   * この文書の相手先。選んだ条件が1社に決まるときだけ。
   * 「探して入れる」でこの取引先の契約・文書を引くのに使う。
   * 混ざっているときは絞らない（どちらの契約かを決められない）。
   */
  const partyId = (() => {
    const ids = [...new Set(picked
      .map((id) => conditions.find((c) => c.id === id)?.counterparty?.id)
      .filter((v): v is number => typeof v === "number"))];
    return ids.length === 1 ? ids[0] : null;
  })();
  // 基本契約の選択肢は、この相手先の契約だけ。他社の契約が並ぶと選び間違える。
  useEffect(() => {
    if (!partyId) { setAgreements([]); return; }
    let live = true;
    api.get<{ agreements: typeof agreements }>("/agreements")
      .then((r) => { if (live) setAgreements(r.agreements.filter((a) => a.counterparty.id === partyId)); })
      .catch(() => { if (live) setAgreements([]); });
    return () => { live = false; };
  }, [partyId]);
  /** 選んだ条件に付いている契約（人が選ばなければこれに従う）。 */
  const conditionAgreement = (() => {
    const found = picked.map((id) => conditions.find((c) => c.id === id)?.agreement).filter(Boolean);
    return found[0] ?? null;
  })();
  /**
   * 本文に渡す値。計算書だけ、手入力に試算の行を足す。
   *
   * 決定するときは /statement-documents が試算の行を本文へ焼き付けるのに、
   * プレビューには渡していなかった。右側だけが明細の無い紙を映し、
   * 「当期利用許諾料（グロス）／固定額／金額なし」という、実際には出ない
   * 見た目になっていた。決定で焼き付けるのと同じ行をここでも渡す。
   */
  const previewInputs = useMemo(() => (
    isStatement && stmt
      ? { ...inputs, statementMode: "bundle",
          rs_bundle_lines: stmt.lines, rs_bundle_tax: stmt.totals.tax }
      : inputs
  ), [isStatement, stmt, inputs]);
  const body = useMemo(() => ({
    templateKey, conditionIds: picked, eventIds: pickedEvents,
    manualInputs: previewInputs, matterId, agreementId
  }), [templateKey, picked, pickedEvents, previewInputs, matterId, agreementId]);

  // 打つたびに問い合わせない。少し待ってからプレビューを取り直す。
  const manualJson = useDebounced(JSON.stringify(previewInputs), 600);

  // ひな形を変えたら、前回そのひな形で入れた値を読み込む。
  // 検収者部署・氏名のように毎回同じものを打ち直さずに済む。
  useEffect(() => {
    if (!templateKey) return;
    // 下書きを開いたときは、その下書きの手入力が正。既定で上書きしない。
    if (draft) return;
    setManual({}); setLines({}); setPickedFields(new Set());
    api.get<{ defaults: Record<string, string> }>(`/document-defaults/${templateKey}`)
      .then((r) => setManual(r.defaults ?? {}))
      .catch(() => undefined);
  }, [templateKey]);

  // ひな形か条件を変えたら、何が要るかを取り直す。押してから足りないと
  // 言われるのでは遅い。
  //
  // **手入力では取り直さない。** 取り直すと入力欄が作り直されて、日本語の
  // 変換中に確定させられる（一文字打つたびに勝手に確定する）。項目の一覧は
  // ひな形と条件と実績だけで決まるので、打っている間は動かさなくてよい。
  useEffect(() => {
    if (!templateKey) { setSpec(null); setRendered(null); return; }
    let live = true;
    api.post<PreviewResponse>("/documents/preview",
      { templateKey, conditionIds: picked, eventIds: pickedEvents, manualInputs: {}, agreementId })
      .then((r) => { if (live) { setSpec(r); setSpecKey(templateKey); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateKey, picked.join(","), pickedEvents.join(","), agreementId]);

  // 本文は打った値で作り直す。iframe の中身が変わるだけで、入力欄には触らない。
  useEffect(() => {
    if (!templateKey) return;
    let live = true;
    api.post<PreviewResponse>("/documents/preview",
      { templateKey, conditionIds: picked, eventIds: pickedEvents,
        manualInputs: JSON.parse(manualJson), agreementId })
      .then((r) => { if (live) setRendered({ html: r.html, templateLabel: r.templateLabel }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [templateKey, picked.join(","), pickedEvents.join(","), manualJson]);

  async function runPreview() {
    setError(null); setIssued(null); setBusy(true);
    try {
      const r = await api.post<PreviewResponse>("/documents/preview", body);
      setRendered({ html: r.html, templateLabel: r.templateLabel });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 計算書の試算。選び直すたびに引き直す。保存しない。
  useEffect(() => {
    if (!isStatement || !stmtEntries.length) { setStmt(null); setStmtError(null); return; }
    let live = true;
    api.post<{ lines: StatementLine[]; totals: StatementTotals }>("/statement-documents/preview", {
      entries: stmtEntries.map((e) => ({ ...e, period: stmtPeriod.trim() || null })),
      // 直した見出し（製品名・対象契約）を試算にも効かせる。ここを渡さないと、
      // 画面で直したのに試算と紙で違う文字が出る。
      manualInputs: inputs
    })
      .then((r) => { if (live) { setStmt(r); setStmtError(null); } })
      .catch((e: ApiError) => { if (live) { setStmt(null); setStmtError(e.message); } });
    return () => { live = false; };
  }, [isStatement, stmtKey, stmtPeriod, JSON.stringify(lines.rs_line_labels ?? null)]);

  /**
   * 最後に保存した中身。これと違えば「保存していない変更がある」。
   * 「やめる」で黙って捨てないための目印。
   */
  const [savedAt, setSavedAt] = useState<string>("");
  const snapshot = () => JSON.stringify({ templateKey, picked, pickedEvents, inputs });
  const dirty = (composing || draft) && Boolean(templateKey) && snapshot() !== savedAt;

  /**
   * 下書きとして保存する。番号は振らない。あとで開き直して続きができる。
   *
   * 以前は「決定する」まで何も保存されず、「やめる」で直した中身が消えていた。
   * 実績の選択は下書きの列に無いので、手入力の中に _eventIds として持たせて
   * 開き直したときに戻す。
   */
  async function saveDraft(): Promise<number | null> {
    if (!templateKey) return null;
    setError(null); setIssued(null); setBusy(true);
    try {
      const manualInputs = { ...inputs, _eventIds: pickedEvents };
      let id: number;
      if (draft) {
        await api.patch(`/documents/${draft.id}/draft`, { manualInputs, conditionIds: picked, agreementId });
        id = draft.id;
      } else {
        const r = await api.post<{ id: number }>("/documents",
          { templateKey, conditionIds: picked, manualInputs, matterId, agreementId });
        id = r.id;
        setDraft({ id, no: null });
      }
      setSavedAt(snapshot());
      setStored(`下書き #${id} を保存しました。一覧の「下書き」から開き直せます`);
      await reload();
      setSelected(id);
      return id;
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  }

  /** 保存していない変更があれば、捨ててよいか聞く。 */
  function confirmDiscard(): boolean {
    if (!dirty) return true;
    return window.confirm("保存していない変更があります。捨ててよいですか？\n（残すなら「やめる」を押して「下書きを保存」を押してください）");
  }

  // 下書きを作ってから発行する。採番は発行時にだけ進む。
  async function issue() {
    setError(null); setBusy(true);
    try {
      let done: { id: number; documentNo: string };
      if (draft) {
        // 開いている下書きを直してから発行する。発行は下書きに保存された
        // 手入力しか見ないので、先に書き戻す。
        await api.patch(`/documents/${draft.id}/draft`,
          { manualInputs: { ...inputs, _eventIds: pickedEvents }, conditionIds: picked, agreementId });
        const r = await api.post<{ id: number; documentNo: string }>(
          `/documents/${draft.id}/issue`, { eventIds: pickedEvents });
        done = { id: r.id, documentNo: r.documentNo };
      } else if (isStatement) {
        // 計算書は 試算 → 発行 → 確定 を1本にしてある。金額は確定時にもう一度
        // 計算し直すので、画面に出ている試算の値は送らない。
        const result = await api.post<{ document: { id: number; documentNo: string } }>(
          "/statement-documents", {
            templateKey, matterId,
            manualInputs: inputs,
            entries: stmtEntries.map((e) => ({ ...e, period: stmtPeriod.trim() || null }))
          });
        done = { id: result.document.id, documentNo: result.document.documentNo };
      } else {
        // 下書き→発行→実績への紐づけをサーバ側で1本にしてある。
        // 途中で落ちたときは下書きごと捨てられる。
        const result = await api.post<{ document: { id: number; documentNo: string } }>(
          "/documents/compose", body);
        done = { id: result.document.id, documentNo: result.document.documentNo };
      }
      setIssued(done);
      // 手で打った項目だけ覚える。日付と金額は毎回変わるので覚えない
      // （前回の日付が入ったまま気づかず発行してしまう）。
      const keep: Record<string, string> = {};
      for (const f of spec?.fields ?? []) {
        if (f.source !== "manual") continue;   // 自動の欄の上書きは今回だけ
        const kind = kindFor(f.name, f.label, f.type);
        const value = String(manual[f.name] ?? "").trim();
        if (value && !pickedFields.has(f.name) && kind !== "date" && kind !== "amount") {
          keep[f.name] = value;
        }
      }
      if (Object.keys(keep).length) {
        await api.put(`/document-defaults/${templateKey}`, { values: keep }).catch(() => undefined);
      }
      // 項目の一覧は消さない。消すと、続けてもう1枚作るときに空の画面が残る。
      // 日付と金額だけ落として、手で打った文字は次にも使う。
      setManual(keep); setLines({}); setPickedFields(new Set());
      setDraft(null); setPickedEvents([]); setStmt(null); setStmtPeriod("");
      await reload();
      // 長いフォームの下で押すと、上に出た結果が見えない。結果まで運ぶ。
      issuedRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 一覧で選んだ下書きをそのまま発行する。フォームに載せ直す手間を省くため。
   *
   * 訂正版ならこの1回で前の版が退き、実績もこちらへ移る。以前は
   * 「新版を発行」「旧版を無効化」の2手が要り、間の一瞬だけ両方が有効に見えていた。
   *
   * すでにフォームに載せている下書きなら、画面で直した内容を先に書き戻したいので
   * いつもの発行を通す。
   */
  async function issueDraft(id: number) {
    if (draft?.id === id) { await issue(); return; }
    setError(null); setIssued(null); setBusy(true);
    try {
      // 実績はサーバが持っているものを使う。画面で選び直していない下書きを
      // 空の実績で発行すると、前の版が結んでいた実績が宙に浮く。
      const d = await api.get<{ eventIds: number[]; manualInputs: Record<string, unknown> }>(`/documents/${id}`);
      // 前の版から引き継いだ実績が無ければ、下書きに控えた選択を使う。
      const saved = Array.isArray(d.manualInputs?._eventIds)
        ? (d.manualInputs._eventIds as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : [];
      const r = await api.post<{ id: number; documentNo: string }>(
        `/documents/${id}/issue`, { eventIds: d.eventIds?.length ? d.eventIds : saved });
      setIssued({ id: r.id, documentNo: r.documentNo });
      await reload();
      setSelected(id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * この書類から支払を立てる。
   *
   * 当社の支払は検収書か利用許諾計算書から起きる。経理提出用の一覧は支払から
   * 作られるので、ここを通らないと経理に出ない。二重に立てようとするとサーバが断る。
   */
  async function createPayment(id: number) {
    setError(null); setStored(null); setBusy(true);
    try {
      const r = await api.post<{ paymentId: number; amount: number; dueOn: string | null }>(
        `/documents/${id}/payment`, {});
      setStored(`支払 #${r.paymentId} を立てました`
        + `（${money(r.amount)}${r.dueOn ? `　支払期日 ${r.dueOn}` : ""}）。`
        + "経理提出用は「運用」の出力タブから出せます");
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // Drive へ保存する。既存ファイルがあれば中身だけ差し替わり、リンクは変わらない。
  /**
   * 無効化。理由を必ず聞く。行は消えず、発行した記録は残る。
   * 外に出したファイルは取り消せないので、そこも伝える。
   */
  async function voidDocument(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} を無効にします。理由を書いてください。\n` +
      "記録は残ります。すでに送付・保存したファイルは取り消せません。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/documents/${id}/void`, { reason });
      // 決定の結果とは別。無効化に「この文書を開く」を出しても仕方がない。
      setStored(`${no ?? id} を無効にしました`);
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 訂正版を作る。条件・実績・手入力を引き継いだ下書きができるだけで、
   * ここでは前の版はまだ有効なまま。入れ替わるのは訂正版を発行した瞬間。
   * 下書きのまま捨てても、前の版が生きているので穴が開かない。
   */
  async function reissue(id: number, no: string | null) {
    const reason = window.prompt(
      `${no ?? "この文書"} の訂正版を作ります。訂正の理由を書いてください。\n` +
      "条件も実績も引き継いだ下書きができます。" +
      "決定した瞬間にこの版と入れ替わるので、先に無効にする必要はありません。");
    if (reason === null) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${id}/reissue`, { reason });
      await reload();
      // 作っただけでは直せない。そのまま上のフォームに載せる。
      await openDraft(r.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 下敷きにして次を作る。発注書から検収書、契約書から覚書、同じ発注のもう1枚。
   * 前の文書は退かない。できた下書きをそのままフォームに載せる。
   */
  async function derive(id: number, templateKey: string) {
    setBusy(true); setError(null); setIssued(null);
    try {
      const r = await api.post<{ id: number }>(`/documents/${id}/derive`, { templateKey });
      await reload();
      await openDraft(r.id);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /**
   * 下書きを上のフォームに載せる。ひな形・条件・手入力をそのまま引き継ぐ。
   * 作り直した下書きを直して発行するには、ここを通る。
   */
  async function openDraft(id: number) {
    setError(null); setIssued(null); setBusy(true);
    try {
      const d = await api.get<{
        id: number; documentNo: string | null; templateKey: string | null;
        matterId: number | null; agreementId: number | null;
        manualInputs: Record<string, unknown>;
        conditions: Array<{ id: number }>;
        eventIds: number[];
      }>(`/documents/${id}`);
      setDraftMatterId(d.matterId ?? null);
      setAgreementId(d.agreementId ?? null);
      if (!d.templateKey) {
        throw new ApiError(400, "ひな形を持たない文書は直せません");
      }
      const values: Record<string, string> = {};
      const arrays: Record<string, Row[]> = {};
      const savedEvents = Array.isArray(d.manualInputs?._eventIds)
        ? (d.manualInputs._eventIds as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : [];
      for (const [k, v] of Object.entries(d.manualInputs ?? {})) {
        if (k === "_eventIds") continue;
        if (Array.isArray(v)) arrays[k] = v as Row[];
        else if (v !== null && v !== undefined && typeof v !== "object") values[k] = String(v);
      }
      // draft を先に立てる。ひな形を変えたときの既定読み込みに上書きさせない。
      setComposing(true);
      setDraft({ id: d.id, no: d.documentNo });
      setTemplateKey(d.templateKey);
      setPicked(d.conditions.map((c) => c.id));
      // 実績も戻す。訂正版の下書きなら、前の版が結んでいた実績が返ってくる。
      // ここを空にすると、直して発行するたびに実績を選び直す羽目になる。
      // 実績は 前の版のもの（訂正版）→ 下書きに控えたもの の順で戻す。
      const events = d.eventIds?.length ? d.eventIds : savedEvents;
      setPickedEvents(events);
      setManual(values);
      setLines(arrays);
      setPickedFields(new Set());
      setSavedAt(JSON.stringify({ templateKey: d.templateKey, picked: d.conditions.map((c) => c.id),
                                  pickedEvents: events, inputs: { ...values, ...arrays } }));
      form.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  /** 下書きから降りる。作りかけの下書きは残るので、あとで開き直せる。 */
  function closeDraft() {
    setDraft(null); setComposing(false); setRendered(null); setSavedAt("");
    setManual({}); setLines({}); setPickedFields(new Set()); setPickedEvents([]);
    // ひな形は変わらないので既定の読み込みは走らない。ここで戻しておかないと、
    // 下書きを閉じたあとだけ前回の値が出ない画面になる。
    if (templateKey) {
      api.get<{ defaults: Record<string, string> }>(`/document-defaults/${templateKey}`)
        .then((r) => setManual(r.defaults ?? {}))
        .catch(() => undefined);
    }
  }

  async function store(id: number) {
    setError(null); setStored(null); setBusy(true);
    try {
      const result = await api.post<{ storageUrl: string; mode: string }>(`/documents/${id}/store`);
      setStored(result.mode === "unchanged" ? "すでに保存済みです"
        : result.mode === "replaced" ? "Drive のファイルを差し替えました（リンクは変わりません）"
        : "Drive に保存しました");
      await reload();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  // 未入力は画面の入力値で数える。項目の一覧は手入力を空にして取っているので、
  // spec.missing はひな形が要求する項目の一覧であって、残数ではない。
  const remaining = (spec?.fields ?? [])
    .filter((f) => f.required && f.source === "manual" && !String(manual[f.name] ?? "").trim()).length;
  // 作成中（新規・下書きを直している）か。作成中は下の一覧を畳む。
  const composeMode = composing || Boolean(draft);
  /**
   * 作成中に出す面（狭い画面のとき）。ウィンドウを半分にすると入力と
   * プレビューは並ばず、プレビューが入力欄の全長より下に落ちる。
   * 並べられない幅では、見る面を切り替える。
   */
  const [composePane, setComposePane] = useState<"form" | "preview">("form");
  const listShown = !composeMode || listWhileComposing;
  // 計算書は試算が返って初めて出せる。金額の無い紙を出させない。
  const ready = Boolean(templateKey) && spec !== null && specFresh && remaining === 0
    && (!isStatement || stmt !== null);

  return (
    <section className={`workspace${selected === null ? "" : " picked"}`}>
      <header className="workspace-head">
        <h1>文書</h1>
        <p>文書は条件の出力物。相手先も件名も条件と合意から解決するので、入力するのはそこから決まらないものだけ。</p>
      </header>

      {error && <div className="alert">{error}</div>}
      {issued && (
        <div ref={issuedRef} className="note ok done-note">
          <div className="row">
            <b>決定しました</b>
            <span className="code">{issued.documentNo}</span>
            <span className="faint">番号が振られ、中身は直せなくなりました</span>
          </div>
          <div className="row">
            <button className="btn primary btn-sm" onClick={() => {
              // 一覧と詳細は作成中は出ないので、閉じてから開く。
              setComposing(false); setDraft(null); setBulk(false);
              setSelected(issued.id); setIssued(null);
            }}>この文書を開く</button>
            {(composing || draft) && (
              <button className="btn btn-sm" onClick={() => setIssued(null)}>
                続けてもう1枚作る
              </button>
            )}
            <button className="btn btn-sm" onClick={() => {
              setComposing(false); setDraft(null); setBulk(false);
              setRendered(null); setSavedAt(""); setIssued(null);
            }}>閉じて一覧へ</button>
          </div>
        </div>
      )}
      {stored && <div className="note ok">{stored}</div>}
      {integrations && !integrations.drive.documents && (
        <div className="note">Drive 保存は未設定です（<span className="code">GOOGLE_DRIVE_FOLDER_ID</span>）。文書の作成と決定はそのまま使えます。</div>
      )}

      <div className="stack">
        {!composing && !draft && !bulk && (
          <div className="row">
            <button className="btn primary" onClick={() => setComposing(true)}>
              新しく文書を作る
            </button>
            {/* 何がまとまるのか分からない名前だった。CSV から作れるのは
                発注書だけなので、そう書く。 */}
            <button className="btn" onClick={() => { setBulk(true); setSettled(false); }}>
              ↑ 発注書をまとめて作る
            </button>
            {/* 上は「これから出す紙」、こちらは「もう終わった取引」。
                同じ CSV の口でも作るものが違うので、入口から分ける。 */}
            <button className="btn" onClick={() => { setSettled(true); setBulk(false); }}>
              ↑ 検収済みをまとめて入れる
            </button>
            <span className="faint">
              ひな形から起こします。すでにある文書を見るだけなら、下の一覧から選んでください
            </span>
          </div>
        )}

        {bulk && !composing && !draft && (
          <BulkOrders templates={templates} initialMatterId={start?.matterId ?? null}
            onOpenDocument={(id) => { setSelected(id); }}
            onClose={() => setBulk(false)}
            onCreated={(id) => { setBatchId(id); void reload(); }} />
        )}

        {settled && !composing && !draft && (
          <SettledImport initialMatterId={start?.matterId ?? null}
            onOpenDocument={(id) => { setSelected(id); }}
            onClose={() => setSettled(false)}
            onCreated={() => { void reload(); }} />
        )}

        {(composing || draft) && (
        <>
        {/* 並べられない幅のときだけ出る切り替え。広い画面では CSS で消える。 */}
        <div className="compose-switch">
          <button className="chip" aria-pressed={composePane === "form"}
                  onClick={() => setComposePane("form")}>入力</button>
          <button className="chip" aria-pressed={composePane === "preview"}
                  onClick={() => setComposePane("preview")}>プレビューと点検</button>
        </div>
        <div className={`compose pane-${composePane}`} ref={form}>
          {/* 左：何から作るか → 区分ごとの入力。右：プレビューと点検（付いてくる）。 */}
          <div className="stack compose-main">
          <div className="panel">
            <div className="panel-hd">
              <h2>{draft ? "下書きを直して決定する" : "新しく文書を作る"}</h2>
              {!draft && (
                <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                        onClick={() => { if (confirmDiscard()) { setComposing(false); setRendered(null); setSavedAt(""); } }}>
                  やめる
                </button>
              )}
              {draft && (
                <span className="row" style={{ marginLeft: "auto" }}>
                  <span className="faint">下書き #{draft.id}</span>
                  <button className="btn btn-sm" disabled={busy}
                          onClick={() => { if (confirmDiscard()) closeDraft(); }}>
                    閉じる
                  </button>
                </span>
              )}
            </div>
            <div className="panel-bd stack">
              {draft && (
                <div className="note">
                  下書きを直しています。ひな形は元の版のまま変えられません。
                  直して決定すると、この下書きが決定済みになります。
                </div>
              )}
              <label className="field">
                <span>テンプレート</span>
                {/* 下書きはひな形の版を持っている。ここで変えても発行はその版で走るので、
                    選ばせない。ひな形を変えたいなら作り直しではなく新規で作る。 */}
                <select value={templateKey} disabled={Boolean(draft)}
                        onChange={(e) => setTemplateKey(e.target.value)}>
                  {templates.map((t) => (
                    <option key={t.templateKey} value={t.templateKey}>{t.label}</option>
                  ))}
                </select>
                {/* ひな形の名前は文書の一覧の「種別」にも出るので短くしてある。
                    どちらを選ぶかの手がかりは名前ではなく、ここに出す。 */}
                {PUB_TERMS_TEMPLATE_HINT[templateKey] && (
                  <small className="faint">{PUB_TERMS_TEMPLATE_HINT[templateKey]}</small>
                )}
              </label>

              <div className="stack" style={{ gap: 6 }}>
                <div className="row">
                  <span className="faint">
                    この文書に載せる条件明細（契約の中の行）を選ぶ
                  </span>
                  <span className="faint" style={{ marginLeft: "auto" }}>
                    {picked.length ? `${picked.length} 件を選択中` : "選ばなくても作れます"}
                  </span>
                </div>
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={condSearch} placeholder="条件番号・名称・相手先・契約で絞る"
                         style={{ flex: 1, minWidth: 200 }} onChange={(e) => setCondSearch(e.target.value)} />
                  {matterId && (
                    <button type="button" className="chip" aria-pressed={scopeToMatter}
                            title="この案件に紐づく条件だけを候補に出す。外すと全社の条件から選べる"
                            onClick={() => setScopeToMatter((v) => !v)}>
                      この案件の条件だけ{matterConditions ? `（${matterConditions.length}）` : ""}
                    </button>
                  )}
                  {supersededCount > 0 && (
                    <button type="button" className="chip" aria-pressed={showSuperseded}
                            title="改訂前の版（差し替え済み）も候補に出す。ふつうは今の版に載せる"
                            onClick={() => setShowSuperseded((v) => !v)}>
                      旧版も表示（{supersededCount}）
                    </button>
                  )}
                  {/* 支払済み・完了扱いの条件は既定で出さない。検収書を作るときに
                      払い終えた条件が何十本も並ぶと、載せる条件が探せない。 */}
                  <button type="button" className="chip" aria-pressed={showSettled}
                          title="支払済み・完了扱いの条件も候補に出す"
                          onClick={() => setShowSettled((v) => !v)}>
                    完了も表示{settledCount ? `（${settledCount}）` : ""}
                  </button>
                </div>
                <div className="picker">
                  {shownConditions
                    .map((c) => (
                    <label key={c.id} className="pick">
                      <input type="checkbox" checked={picked.includes(c.id)}
                             onChange={(e) => {
                               setPicked((prev) => e.target.checked
                                 ? [...prev, c.id] : prev.filter((id) => id !== c.id));
                             }} />
                      <span className={`tag ${c.direction}`}>{c.direction === "in" ? "IN" : "OUT"}</span>
                      {/* 出すものは型で変える。ライセンスは作品と取引モデル、
                          業務委託は件名と金額で見分ける。 */}
                      <ConditionLabel c={c} />
                      {c.settlement && c.settlement.state !== "open" && <SettlementTag settlement={c.settlement} compact />}
                      {/* どの契約の明細かが分かると、選び間違いが減る。 */}
                      <span className="faint" style={{ marginLeft: "auto" }}>
                        {c.agreement ? c.agreement.title : "契約なし"}
                      </span>
                    </label>
                  ))}
                </div>
                {/* 80点の作品（条件 170 本）を1通に載せることがある。1件ずつ押して
                    いられないので、絞り込んだぶんをまとめて選べるようにする。
                    選んだ数と、出していない件数もここで分かるようにする。 */}
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="faint">
                    選択 {picked.length} 件／候補 {matchedConditions.length} 件
                    {hiddenConditions > 0 && `（うち ${hiddenConditions} 件は未表示）`}
                  </span>
                  {matchedConditions.length > 0 && (
                    <button type="button" className="btn btn-sm"
                            onClick={() => setPicked((prev) => [...new Set([...prev, ...matchedConditions.map((c) => c.id)])])}>
                      この {matchedConditions.length} 件をまとめて選ぶ
                    </button>
                  )}
                  {hiddenConditions > 0 && (
                    <button type="button" className="btn btn-sm"
                            onClick={() => setShownLimit((n) => n + 100)}>
                      もっと出す（+100）
                    </button>
                  )}
                  {picked.length > 0 && (
                    <button type="button" className="btn btn-sm" onClick={() => setPicked([])}>
                      選択をすべて外す
                    </button>
                  )}
                </div>
                {/* 基本契約。発注書の準拠条項と「基本契約名 / 番号」はここから出る。
                    条件に契約が付いていれば黙ってそれを使うが、付いていない条件や
                    別の契約に基づく発注では人が選ぶ。 */}
                {picked.length > 0 && partyId && (
                  <label className="field" style={{ marginTop: 6 }}>
                    <span>基本契約</span>
                    <span className="stack" style={{ gap: 2 }}>
                      <select value={agreementId ?? ""} onChange={(e) => setAgreementId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">
                          {conditionAgreement
                            ? `条件の契約に従う（${conditionAgreement.title}${conditionAgreement.agreementNo ? ` ${conditionAgreement.agreementNo}` : ""}）`
                            : "条件に契約が付いていない（基本契約なしで出す）"}
                        </option>
                        {agreements.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.title}{a.agreementNo ? ` ${a.agreementNo}` : ""}{a.status !== "executed" ? `（${a.status}）` : ""}
                          </option>
                        ))}
                      </select>
                      <small className="faint">
                        発注書の「基本契約名 / 番号」と準拠条項に出ます。基本契約に基づかない発注にするなら、
                        項目の「基本契約あり」を外してください
                      </small>
                    </span>
                  </label>
                )}
              </div>

              {(events.length > 0 || ((usesDeliveryLines || isStatement) && picked.length > 0)) && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="row">
                    <span className="faint">
                      {isStatement
                        ? "どの実績を載せるか（選んだ実績の根拠を条件ごとに合算して計算します）"
                        : "どの実績についてか（検収書・納品書はここの1件が明細の1行になります）"}
                    </span>
                    <span className="faint" style={{ marginLeft: "auto" }}>
                      {picked.length > 1 ? "条件をまたいで選べます。委託料と実費を1枚の検収書に" : ""}
                      {pickedEvents.length ? `　${pickedEvents.length} 件を選択中` : ""}
                    </span>
                  </div>
                  {/* 実績の無い条件は明細に出ない。黙って消すと「選んだのに反映されない」に見える。 */}
                  {withoutEvents.length > 0 && (
                    <div className="note warn">
                      選んだ条件のうち {withoutEvents.length} 件は実績が無いので明細に出ません。
                      条件の画面で実績を登録してから作り直してください。
                    </div>
                  )}
                  <div className="picker">
                    {picked.map((cid) => {
                      const mine = events.filter((e) => e.conditionId === cid);
                      const c = conditions.find((x) => x.id === cid);
                      const no = mine[0]?.conditionNo ?? c?.conditionNo ?? `#${cid}`;
                      const nm = mine[0]?.conditionName ?? c?.name ?? "";
                      return (
                        <Fragment key={cid}>
                          {picked.length > 1 && (
                            <div className="faint" style={{ marginTop: 4 }}>
                              <span className="code">{no}</span> {nm}
                            </div>
                          )}
                          {mine.length === 0 && (
                            <div className="faint" style={{ padding: "4px 8px" }}>
                              実績がありません（取り消した実績は出ません）。この条件は明細に出ません。
                            </div>
                          )}
                          {mine.map((e) => (
                            <label key={e.id} className="pick" style={e.documentId ? { opacity: 0.6 } : undefined}>
                              <input type="checkbox" checked={pickedEvents.includes(e.id)}
                                     disabled={Boolean(e.documentId) && !pickedEvents.includes(e.id)}
                                     onChange={(ev) => setPickedEvents((prev) => ev.target.checked
                                       ? [...prev, e.id] : prev.filter((id) => id !== e.id))} />
                              <span className="code">{e.occurredOn ?? "—"}</span>
                              <span>{e.period ?? ""}</span>
                              <span className="num">{money(e.amount)}</span>
                              {e.documentId && <span className="faint">文書あり</span>}
                            </label>
                          ))}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 計算書の枠。ほかのひな形は本文の項目を人が埋めるが、計算書の金額は
                  条件と実績から計算して決まる。ここが無いと、条件を選んでも
                  入力欄が1つも出ないまま「決定する」だけが残る。 */}
              {isStatement && (
                <div className="stack" style={{ gap: 6 }}>
                  <label className="field">
                    <span>対象期間</span>
                    <input value={stmtPeriod} onChange={(e) => setStmtPeriod(e.target.value)}
                           placeholder="2026上期（空なら選んだ実績の期間から決めます）" />
                  </label>
                  {stmtError && <div className="alert">{stmtError}</div>}
                  {stmt
                    ? <StatementBreakdown lines={stmt.lines} totals={stmt.totals} />
                    : !stmtError && (
                      <div className="note">
                        条件明細と、その条件の実績を選ぶと、取引モデルごとの内訳と合計が出ます。
                        計算は条件ごと（料率も MG・AG も条件ごとに違う）で、1枚にまとめるのは
                        印字と支払のまとめ方だけです。
                      </div>
                    )}
                </div>
              )}

            </div>
          </div>

          <DocumentFields fields={spec?.fields ?? []} manual={manual}
            candidates={spec?.candidates ?? []} partyId={partyId}
            blanked={blankedNames(manual)}
            onBlank={(name, on) => setManual((prev) => {
              const next = { ...prev };
              const set = blankedNames(prev);
              if (on) { set.add(name); delete next[name]; } else set.delete(name);
              if (set.size) next[BLANK_INPUT_KEY] = JSON.stringify([...set]); else delete next[BLANK_INPUT_KEY];
              return next;
            })}
            onChange={(name, value) => {
              setManual((prev) => {
                const next = { ...prev };
                // 空にしたら「入れていない」に戻す。空文字を送ると自動の値を消してしまう。
                if (value === "") delete next[name]; else next[name] = value;
                return next;
              });
              setPickedFields((prev) => { const next = new Set(prev); next.delete(name); return next; });
            }}
            onPick={(name, value) => {
              setManual((prev) => ({ ...prev, [name]: value }));
              setPickedFields((prev) => new Set(prev).add(name));
            }} />

          {/* 条件書は明細ではなく2つの表（取引形態・構成要素）。列も編集の仕方も
              違うので、専用の欄で出す。 */}
          {isLicenseTerms && (
            <LicenseTermsMatrix
              deals={lines.v3_conds ?? null} materials={lines.v3_lcs ?? null}
              sublicensees={lines.v3_sublicensees ?? null}
              extras={lines.v3_special_extras ?? null}
              seedDeals={spec?.lines.find((l) => l.name === "v3_conds")?.rows ?? []}
              seedMaterials={spec?.lines.find((l) => l.name === "v3_lcs")?.rows ?? []}
              onChange={(name, rows) => setLines((prev) => {
                const next = { ...prev };
                if (rows === null) delete next[name]; else next[name] = rows;
                return next;
              })} />
          )}

          {/* 明細の行。条件明細には無いが書類には要る項目（帰属先・支払方法・
              納期・支払日）は、ここで行ごとに入れる。 */}
          {!isLicenseTerms && (spec?.lines ?? []).map((l) => (
            <LineItemsEditor key={l.name} name={l.name} seed={l.rows}
              rows={lines[l.name] ?? null} intl={templateKey === "intl_purchase_order"}
              onChange={(rows) => setLines((prev) => {
                const next = { ...prev };
                if (rows === null) delete next[l.name]; else next[l.name] = rows;
                return next;
              })} />
          ))}
          </div>

          <aside className="compose-side stack">
            <div className="panel">
              <div className="panel-hd">
                <h2>決定前の点検</h2>
                <span className="faint">{spec ? `${spec.fields.length} 項目` : "ひな形を選ぶと出ます"}</span>
              </div>
              <div className="panel-bd stack">
                {spec && isStatement && (
                  <div className="check-list">
                    <div className={stmt ? "ok" : "ng"}>
                      {stmt
                        ? `✓ ${stmt.lines.length} 件の取引モデルで試算できています`
                        : "✕ 条件明細と実績を選ぶと試算します"}
                    </div>
                    <div className="faint">
                      金額は決定するときにもう一度計算し直します。下書きにはできません
                    </div>
                  </div>
                )}
                {spec && (
                  <div className="check-list">
                    <div className={remaining === 0 ? "ok" : "ng"}>
                      {remaining === 0 ? "✓ 必須の入力は揃っています" : `✕ 未入力 ${remaining} 件：`}
                      {remaining > 0 && (
                        <span className="faint">
                          {" "}{spec.fields.filter((f) => f.required && f.source === "manual"
                              && !String(manual[f.name] ?? "").trim()).map((f) => f.label).join("・")}
                        </span>
                      )}
                    </div>
                    <div className="faint">
                      自動 {spec.fields.filter((f) => f.source !== "manual").length} 項目を条件・相手先・案件から、
                      手入力 {spec.fields.filter((f) => f.source === "manual").length} 項目を人が入れます
                      {picked.length ? `。条件明細 ${picked.length} 件` : "。条件明細なし"}
                      {pickedEvents.length ? `、実績 ${pickedEvents.length} 件` : ""}
                    </div>
                  </div>
                )}
              {/* 宣言されていない差し込みの空欄。振込先の欠けはここにしか出ない
                  （必須項目の未入力は上の一覧に出る）。発行は止めない。 */}
              {(spec?.warnings ?? []).map((w) => (
                <div key={w.kind} className="note warn">{w.message}</div>
              ))}

                <div className="compose-actions">
                  {/* 計算書は 試算 → 発行 → 確定 が1本。下書きで止めると、金額の
                      決まっていない紙が残り、あとから発行しても計算書が結ばれない。 */}
                  <button className="btn" onClick={() => void saveDraft()}
                          disabled={busy || !templateKey || !dirty || isStatement}
                          title={isStatement ? "計算書は下書きにできません（試算した金額のまま出します）" : undefined}>
                    {draft ? "下書きを保存" : "下書きとして保存"}
                  </button>
                  <button className="btn primary" onClick={issue} disabled={busy || !ready}>
                    {draft ? "直して決定する" : "決定する"}
                  </button>
                  <button className="btn" onClick={runPreview} disabled={busy || !templateKey}>
                    プレビューを更新
                  </button>
                  <span className="faint">
                    {dirty ? "保存していない変更があります。" : draft ? "保存済みです。" : ""}
                    決定すると番号が振られ、中身は直せなくなります
                  </span>
                </div>
              </div>
            </div>

            {rendered && (
              <div className="panel">
                <div className="panel-hd"><h2>プレビュー</h2><span className="faint">{rendered.templateLabel}</span></div>
                <iframe className="preview" title="文書プレビュー" srcDoc={rendered.html} />
              </div>
            )}
          </aside>
        </div>
        </>
        )}

        <div className="split">
          <div className="panel md-list">
            <div className="panel-hd">
              <h2>文書</h2>
              {listShown ? (
                <>
                  <span className="faint">いまの版だけを並べています</span>
                  <ListSearch value={keyword} onChange={setKeyword}
                    placeholder="文書番号・相手先" label="文書を絞り込む" />
                </>
              ) : (
                <span className="faint">作成中は畳んでいます</span>
              )}
              {composeMode && (
                <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                        onClick={() => setListWhileComposing(!listWhileComposing)}>
                  {listShown ? "一覧を畳む" : `一覧を開く（${documents.length} 件）`}
                </button>
              )}
            </div>
            {listShown && (
            <>
            <div className="panel-bd" style={{ paddingBottom: 0 }}>
              <div className="filters">
                {SCOPES.map(([value, label]) => (
                  <button key={value} className="chip" aria-pressed={scope === value}
                          onClick={() => setScope(value)}>{label}</button>
                ))}
                {batchId && (
                  <button className="chip" aria-pressed onClick={() => setBatchId(null)}
                          title="この束の絞り込みを外す">一括 #{batchId} ×</button>
                )}
                {/* 案件で絞る。選ぶと札になり、押すと外れる（束の絞りと同じ形）。 */}
                {listMatter ? (
                  <button className="chip" aria-pressed
                          onClick={() => { setListMatter(""); setListMatterLabel(null); }}
                          title="案件の絞り込みを外す">
                    {listMatterLabel ?? `案件 #${listMatter}`} ×
                  </button>
                ) : (
                  <span style={{ minWidth: 230 }}>
                    <SearchSelect value={listMatter}
                      onChange={(value, option) => {
                        setListMatter(value); setListMatterLabel(option?.label ?? null);
                      }}
                      search={searchMattersForList} placeholder="案件で絞る" />
                  </span>
                )}
              </div>
              {scope === "unlinked" && (
                <div className="faint" style={{ marginTop: 7 }}>
                  条件明細が繋がっていない文書。取り込んだ書類は、どの取引から出たものか
                  が分からないままになっています。1件ずつ開いて繋いでください。
                </div>
              )}
            </div>
            <ListCount shown={documents.length} keyword={search} onClear={() => setKeyword("")} />
            <div className="tablewrap">
              <table>
                <thead><tr>
                  <th>文書番号</th><th>種別</th><th>条件明細 ／ 案件</th><th>状態</th>
                </tr></thead>
                <tbody>
                  {heads.map((d) => {
                    const older = ancestorsOf(d);
                    const open = unfolded.has(d.id);
                    return (
                      <Fragment key={d.id}>
                        <tr className={d.id === selected ? "sel" : ""} tabIndex={0}
                            aria-selected={d.id === selected}
                            onClick={() => setSelected(d.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault(); setSelected(d.id);
                              }
                            }}>
                          <td className="code">
                            {d.documentNo ?? "（未決定）"}
                            {/* 訂正版の下書きは、どの版を直しているのかが分からないと
                                「（未発行）」の行が2つ並ぶだけになる。 */}
                            {d.supersedesId !== null && (
                              <div className="faint">
                                {byId.get(d.supersedesId)?.documentNo ?? `#${d.supersedesId}`} の訂正版
                              </div>
                            )}
                          </td>
                          <td>
                            {d.templateLabel ?? "—"}
                            <div className="faint">{d.counterparty ?? "相手先なし"}</div>
                          </td>
                          <td><Refs doc={d} onOpen={onOpen} /></td>
                          <td>
                            <StatusTag kind="document" value={d.phase} />
                            {/* まだ有効な版に訂正版の下書きが付いている状態。
                                これを出さないと、似た行が2つある理由が読めない。 */}
                            {d.status === "issued" && d.supersededById !== null && (
                              <div className="faint">訂正版の下書きあり</div>
                            )}
                          </td>
                        </tr>
                        {older.length > 0 && (
                          <tr>
                            <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
                              <button className="fold" onClick={(e) => {
                                e.stopPropagation();
                                setUnfolded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                  return next;
                                });
                              }}>
                                <span className="caret">{open ? "▾" : "▸"}</span>
                                この文書の旧版 {older.length} 件
                              </button>
                            </td>
                          </tr>
                        )}
                        {open && older.map((o) => (
                          <tr key={o.id} className={`older${o.id === selected ? " sel" : ""}`}
                              tabIndex={0} onClick={() => setSelected(o.id)}>
                            <td className="code faint">{o.documentNo ?? "（未決定）"}</td>
                            <td className="faint">{o.templateLabel ?? "—"}</td>
                            <td className="faint">同上</td>
                            <td><StatusTag kind="document" value={o.phase} /></td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                  {!documents.length && (
                    <tr><td colSpan={4} className="faint">
                      {search.trim() ? `「${search}」に一致する文書はありません` : "文書がありません"}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="panel-bd" style={{ borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ gap: 16, fontSize: 11.5, color: "var(--muted)" }}>
                <span><b>下書き</b> まだ決めていない。中身を直せる</span>
                <span><b>決定済み</b> 番号が振られた。中身は直せない。次は送る</span>
                <span><b>送信済み</b> 相手に送った</span>
                <span><b>訂正版あり</b> 新しい版に差し替わった</span>
              </div>
            </div>
            </>
            )}
          </div>

          <div className="stack md-detail">
          <DetailBack label="文書" count={documents.length} onBack={() => setSelected(null)} />
          {current && (
            <DocumentDetail
              onPayment={createPayment}
              doc={current} versions={chainOf(current)} templates={templates}
              integrations={integrations} busy={busy}
              onOpen={onOpen} onChanged={() => void reload()}
              onEditDraft={(id) => void openDraft(id)}
              onIssueDraft={(id) => void issueDraft(id)}
              onReissue={(id, no) => void reissue(id, no)}
              onDerive={(id, key) => void derive(id, key)}
              onVoid={(id, no) => void voidDocument(id, no)}
              onStore={(id) => void store(id)}
              isAdmin={me?.user?.role === "admin" || me?.user === undefined}
              onLinkCondition={() => setLinkConditions(true)}
              openConditions={linkConditions}
              onSelect={setSelected} />
          )}
          </div>
        </div>

      </div>
    </section>
  );
}
