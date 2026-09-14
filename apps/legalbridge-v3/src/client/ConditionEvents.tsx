import { useEffect, useRef, useState } from "react";
import { api, ApiError, money } from "./api.js";
import { rewardLabelFor } from "../server/core/reward.js";
import { CONTRACT_FORMS } from "../server/conditions/contract-form.js";

/**
 * 条件の実績（明細の数値）。
 *
 * 記録できるのが計算書の作成だけで、製造数も検収も納品も画面から入れられず、
 * 間違って入った数値を直す手段も無かった。
 *
 * 消さずに取り消す。実績は「何がいくつあったか」の記録なので、消すと
 * あとから突き合わせられない。取り消しは理由を必ず添える。
 */

interface EventRow {
  id: number; eventType: string; occurredOn: string | null; period: string | null;
  quantity: number | null; sampleQuantity: number | null;
  grossAmount: number | null; deductions: number; amount: number;
  status: string; note: string | null;
  scheduleId: number | null; scheduleLabel: string | null;
  deliverable: string | null; inspectedOn: string | null;
  inspectorDept: string | null; inspectorName: string | null;
  documentId: number | null; documentNo: string | null;
  createdAt: string; createdBy: string;
  usageType: string | null; usageLabel: string | null;
  outConditionId: number | null; outConditionNo: string | null; outConditionName: string | null;
  unitAmount: number | null; ratePpm: number | null;
  paymentStage: string | null; paymentStageLabel: string | null;
}
interface TypeOption { value: string; label: string }
interface UsageOption {
  value: string; label: string; methodLabel: string;
  needsOutCondition: boolean; fields: string[];
  hasStages: boolean; choosableBasis: boolean; hint: string;
}
interface StageOption { value: string; label: string }
interface OutCondition {
  id: number; conditionNo: string | null; name: string;
  status: string; partyName: string | null; workTitle: string | null; scopes: string | null;
  pricingModel: string; unitAmount: number | null;
}
interface ScheduleRow {
  id: number; seq: number; label: string | null; triggerKind: string;
  plannedAmount: number; dueOn: string | null; eventId: number | null;
  contractForm: string | null; serviceFrom: string | null; serviceTo: string | null;
}
interface TemplateOption { templateKey: string; label: string; category: string | null }
interface StatementPreview {
  fee: { gross_ex_tax: number; mg_topup_this_time: number; ag_offset_this_time: number;
         actual_ex_tax: number; tax_amount: number; formula_breakdown: string };
  payment: { withholdingEnabled: boolean; withholdingTax: number; netTransfer: number };
  period: string; occurredOn: string | null;
  reported: { salesInput?: number | null; quantity?: number | null };
  events: Array<{ eventId: number; eventType: string; occurredOn: string | null; basis: number; share: number }>;
  appliedVersion: { conditionNo: string | null; switched: boolean } | null;
}
interface PreviewResponse {
  templateLabel: string;
  /** 条件と実績から決まらない項目。人が入れないと発行できない。 */
  missing: Array<{ name: string; label: string }>;
  derived: string[];
}

export function ConditionEvents(
  { conditionId, currency, editable, matterId, pricingModel, deliverableOwnership, reloadKey,
    ratePpm, conditionUnitAmount, conditionQuantity, direction, workTitle,
    openForSchedule, onOpened, onCompose, onOpenDocument, onChanged }:
  { conditionId: number; currency: string; editable: boolean;
    matterId?: number | null; reloadKey?: number;
    /** 成果物の帰属先。料率の条件では報酬の呼び方がこれで決まる。 */
    deliverableOwnership?: string | null;
    /** 予定の行の「実績にする」から渡された回。この回でフォームを開く。 */
    openForSchedule?: number | null;
    onOpened?: () => void;
    /** 計算方式。料率・単価×数量なら実績の束から計算書を出せる。 */
    pricingModel?: string;
    /** 条件の料率（百万分率）。実績の料率の初期値になる。 */
    ratePpm?: number | null;
    /** 条件の単価と個数。自社製造・自社販売の基準価格・数量の初期値になる。 */
    conditionUnitAmount?: number | null;
    conditionQuantity?: number | null;
    /** 取得（IN）の条件か。利用形態を付けられるのはこちらだけ。 */
    direction?: string;
    /** 条件の作品。アウト条件の候補を同じ作品に寄せる。 */
    workTitle?: string | null;
    /** 文書の画面へ、この条件と実績を選んだ状態で移る。 */
    onCompose?: (conditionIds: number[], eventIds: number[], matterId?: number | null) => void;
    /** 決めた文書をそのまま開く。決めたあと画面に留まると次の手が分からない。 */
    onOpenDocument?: (documentId: number) => void;
    onChanged: () => void }
) {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [usageTypes, setUsageTypes] = useState<UsageOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [outFound, setOutFound] = useState<OutCondition[]>([]);
  /** 許諾（OUT）の条件が世の中に何件あるか。0件の理由を言い分けるために使う。 */
  const [outTotal, setOutTotal] = useState<number | null>(null);
  const [outQuery, setOutQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  // 実績から文書（検収書など）を作るときの状態。行を選んでテンプレートを決める。
  const [issuing, setIssuing] = useState<EventRow | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [issued, setIssued] = useState<{ id: number; documentNo: string } | null>(null);
  // ひな形が要求する項目のうち、条件と実績から決まらないもの。
  // これを先に見せないと、発行を押してから8項目足りないと言われる。
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  // 実績と同じ理由。フォームは表の上に開くので、下の行から押すと画面の外に出る。
  const issueForm = useRef<HTMLDivElement>(null);
  // 予定の行から開いたとき、フォームが画面の外だと押しても何も起きないように見える。
  const addForm = useRef<HTMLDivElement>(null);
  /**
   * 選んだ実績。複数選んで1枚の書類にする。
   * 料率の条件なら計算書（利用形態のある実績は行ごとに算定、無ければ合算して按分）、
   * 定額なら検収書・納品書（実績が明細の行になる）。
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const royalty = pricingModel === "revenue_rate" || pricingModel === "unit_rate";
  /**
   * 業績連動の報酬（利用許諾料・インセンティブ報酬）。
   *
   * この条件は計算書を出さない。算定は別（売上報告なり社内の集計なり）で行い、
   * 結果の金額を人がここへ入れて、検収書の明細に内訳として載せる。
   * 売上を入れさせて計算書へ誘導すると、二重に計算した別の額が出る。
   */
  const rewardLabel = rewardLabelFor(pricingModel, deliverableOwnership);
  /**
   * 利用形態を付けられるのは取得（IN）の料率・単価×数量の条件だけ。
   * 許諾料は作者から取った権利に対して払うものなので、実績はイン条件に載せる。
   */
  const canUse = royalty && (direction ?? "in") === "in";
  // 条件の料率を実績の初期値にする。その回だけ違う料率があれば直せる。
  const defaultRatePct = ratePpm === null || ratePpm === undefined ? "" : String(ratePpm / 10000);
  const asText = (n: number | null | undefined) =>
    n === null || n === undefined ? "" : String(n);

  /**
   * 利用形態を選んだときの初期値。
   *
   * 自社製造・自社販売の基準価格と個数は条件が持っている。条件に入れたのに
   * 実績で打ち直すのでは、条件に持たせた意味が無い。打ち直した値が条件と
   * 違っていても誰も気づかない。
   *
   * 他社販売の受領価格は相手が払う額なので、条件（作者との契約）ではなく
   * 許諾したアウト条件から入れる。選んだときに埋める。
   */
  function usageDefaults(value: string): Record<string, string> {
    const base = {
      usageType: value, outConditionId: "", grossAmount: "",
      basisKind: "per_unit", paymentStage: "",
      ratePct: v.ratePct || defaultRatePct
    };
    if (value === "in_house") {
      return { ...base, unitAmount: asText(conditionUnitAmount), quantity: asText(conditionQuantity) };
    }
    return { ...base, unitAmount: "", quantity: "" };
  }
  // 予定の回。実績が付いていない回だけ選べる（1つの回に実績は1件）。
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [typeByTrigger, setTypeByTrigger] = useState<Record<string, string>>({});
  // 計算書のフォーム。選んだ実績を束にして出す。
  const [stmtOpen, setStmtOpen] = useState(false);
  const [stmtTemplate, setStmtTemplate] = useState("");
  const [stmtPeriod, setStmtPeriod] = useState("");
  const [stmtPreview, setStmtPreview] = useState<StatementPreview | null>(null);
  const [stmtBusy, setStmtBusy] = useState(false);
  const [stmtDone, setStmtDone] = useState<{ id: number; documentNo: string } | null>(null);

  const pickedIds = [...picked].filter((id) => rows.some((r) => r.id === id && r.status === "active" && !r.documentId));

  // 許諾したアウト条件を引く。作品で寄せてあるので、空欄でも候補が出る。
  useEffect(() => {
    if (!usageTypes.length) return;
    let live = true;
    api.get<{ conditions: OutCondition[]; total: number }>(
      `/conditions/${conditionId}/out-candidates${outQuery.trim() ? `?q=${encodeURIComponent(outQuery.trim())}` : ""}`)
      .then((r) => { if (live) { setOutFound(r.conditions); setOutTotal(r.total); } })
      .catch((e: ApiError) => {
        // 黙って空にしない。候補が出ない理由が読めないと、そこで手が止まる。
        if (live) { setOutFound([]); setOutTotal(null); setError(e.message); }
      });
    return () => { live = false; };
  }, [conditionId, outQuery, usageTypes.length]);

  // 束を変えたら試算し直す。保存しない。
  useEffect(() => {
    if (!stmtOpen || !pickedIds.length) { setStmtPreview(null); return; }
    let live = true;
    api.post<StatementPreview>(`/conditions/${conditionId}/royalty-preview`,
      { eventIds: pickedIds, period: stmtPeriod.trim() || null })
      .then((r) => { if (live) { setStmtPreview(r); setError(null); } })
      .catch((e: ApiError) => { if (live) { setStmtPreview(null); setError(e.message); } });
    return () => { live = false; };
  }, [stmtOpen, pickedIds.join(","), stmtPeriod]);

  async function issueStatement() {
    if (!stmtTemplate || !pickedIds.length) return;
    setStmtBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { id: number; documentNo: string } }>(
        `/conditions/${conditionId}/statement-documents`,
        { templateKey: stmtTemplate, eventIds: pickedIds, period: stmtPeriod.trim() || null,
          matterId: matterId ?? null });
      setStmtDone({ id: r.document.id, documentNo: r.document.documentNo });
      setStmtOpen(false); setPicked(new Set()); setStmtPreview(null);
      load(); onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setStmtBusy(false); }
  }

  function load() {
    api.get<{ events: EventRow[]; types: TypeOption[];
              usageTypes: UsageOption[]; paymentStages: StageOption[] }>(
      `/conditions/${conditionId}/events`)
      .then((r) => {
        setRows(r.events); setTypes(r.types);
        setUsageTypes(r.usageTypes ?? []); setStages(r.paymentStages ?? []);
      })
      .catch((e: ApiError) => setError(e.message));
    // 予定は「どの回の分か」を選ぶために要る。実績の欄だけ見ていると回に繋がらない。
    api.get<{ lines: ScheduleRow[]; eventTypeByTrigger: Record<string, string> }>(
      `/conditions/${conditionId}/schedules`)
      .then((r) => { setSchedules(r.lines ?? []); setTypeByTrigger(r.eventTypeByTrigger ?? {}); })
      .catch(() => { setSchedules([]); });
  }
  // 引き直しでは結果を消さない。消すと、発行した文書番号が出た直後に
  // 引き直しが走って消え、発行できたのかどうか分からなくなる。
  useEffect(() => { load(); setError(null); }, [conditionId, reloadKey]);
  useEffect(() => {
    setAdding(false); setIssuing(null); setIssued(null);
    setPreview(null); setManual({});
  }, [conditionId]);
  // 予定の行の「実績にする」から開く。入力欄は実績の欄ひとつに寄せてある。
  useEffect(() => {
    if (!openForSchedule || !schedules.length) return;
    start(openForSchedule);
    onOpened?.();
    addForm.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [openForSchedule, schedules.length]);

  // テンプレートは文書を作るときにしか要らないので、開くまで取りに行かない。
  useEffect(() => {
    if ((!issuing && !stmtOpen) || templates.length) return;
    api.get<{ templates: TemplateOption[] }>("/document-templates")
      .then((r) => {
        setTemplates(r.templates); setTemplateKey(r.templates[0]?.templateKey ?? "");
        setStmtTemplate(r.templates.find((t) => t.templateKey === "royalty_statement")?.templateKey
          ?? r.templates[0]?.templateKey ?? "");
      })
      .catch((e: ApiError) => setError(e.message));
  }, [issuing, stmtOpen]);

  useEffect(() => {
    if (issuing) issueForm.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [issuing]);

  // ひな形を選んだ時点で、何が足りないかを出す。押してから言われるのでは遅い。
  useEffect(() => {
    if (!issuing || !templateKey) { setPreview(null); return; }
    setPreview(null); setManual({});
    api.post<PreviewResponse>("/documents/preview", {
      templateKey, conditionIds: [conditionId], manualInputs: {}
    }).then(setPreview).catch((e: ApiError) => setError(e.message));
  }, [issuing, templateKey, conditionId]);

  /**
   * 実績から文書を作る。下書き→発行→実績への紐付けをサーバ側で1本にしてある。
   * 紐付けが済んで初めて「この検収書は第N回の分」が読めるようになる。
   */
  const remaining = (preview?.missing ?? [])
    .filter((m) => !String(manual[m.name] ?? "").trim()).length;
  // プレビューが返るまでは押させない。押してから8項目足りないと言われるより、
  // 先に何が要るかを見せる。
  const filled = preview !== null && remaining === 0;

  async function issueDocument() {
    if (!issuing || !templateKey) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ document: { id: number; documentNo: string } }>(
        `/conditions/${conditionId}/event-documents`,
        { templateKey, eventIds: [issuing.id], matterId: matterId ?? null,
          manualInputs: manual });
      setIssued({ id: r.document.id, documentNo: r.document.documentNo });
      setIssuing(null); setPreview(null); setManual({});
      load(); onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const label = (value: string) => types.find((t) => t.value === value)?.label ?? value;
  const set = (k: string, value: string) => setV({ ...v, [k]: value });
  // 入力欄は「足す」を押すまで空。未定義のまま .trim() を呼ぶと画面ごと落ちる。
  const f = (k: string) => v[k] ?? "";

  const openSchedules = schedules.filter((s) => !s.eventId);
  const chosen = openSchedules.find((s) => String(s.id) === (v.scheduleId ?? ""));
  // 検収・納品の実績は検収書の行になる。そのとき出る欄が変わる。
  const inspecting = (v.eventType ?? "") === "inspection" || (v.eventType ?? "") === "delivery";
  // 定期の回か。回を選んでいなければ、種別が役務の期間なら定期とみなす。
  const periodicRound = chosen?.triggerKind === "periodic"
    || (v.eventType ?? "") === "service_period";
  // 選んだ利用形態。これで要る欄が決まる。
  const usage = usageTypes.find((u) => u.value === (v.usageType ?? "")) ?? null;
  // 自社製造・他社販売は契約によって形が違う。前金だけ定額、という契約もある。
  const lumpSum = Boolean(usage?.choosableBasis) && (v.basisKind ?? "per_unit") === "lump";
  const usageField = (name: string) => {
    if (!usage?.fields.includes(name)) return false;
    if (!usage.choosableBasis) return true;
    // 形を選べる場合は、選んだ形で使う欄だけを出す。両方入れた行は保存できない。
    return lumpSum ? name === "grossAmount" : name !== "grossAmount";
  };
  const pickedOut = outFound.find((o) => String(o.id) === (v.outConditionId ?? ""));
  /**
   * 保存する前に、その実績の許諾料を見せる。式はサーバと同じ。
   * 揃っていなければ null（数字が足りないうちは何も出さない）。
   */
  const numOf = (name: string) => {
    const raw = f(name).trim();
    if (!raw) return null;
    const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const usageBasis = (() => {
    if (!usage) return null;
    if (usage.value === "sublicense" || lumpSum) {
      const gross = numOf("grossAmount");
      return gross && gross > 0 ? Math.round(gross) : null;
    }
    const unit = numOf("unitAmount");
    const quantity = numOf("quantity");
    if (!unit || !quantity || unit <= 0 || quantity <= 0) return null;
    const billable = Math.max(0, quantity - (numOf("sampleQuantity") ?? 0));
    return billable > 0 ? Math.round(unit * billable) : null;
  })();
  const usageAmount = (() => {
    const rate = numOf("ratePct");
    if (usageBasis === null || !rate || rate <= 0) return null;
    return Math.ceil((usageBasis * rate) / 100);
  })();

  /** 記録できる状態か。押せないときは、その理由をボタンの横に出す。 */
  const whyNotRecord = (() => {
    if (usage) {
      if (usage.needsOutCondition && !f("outConditionId")) return "許諾したアウト条件を選んでください";
      if (usageBasis === null) {
        return usage.value === "sublicense" || lumpSum
          ? "受領額を入れてください"
          : `${usage.value === "oem" ? "受領価格と製造個数" : "基準価格と数量"}を入れてください`;
      }
      if (usageAmount === null) return "料率を入れてください";
      return "";
    }
    return f("amount").trim() ? "" : "実額を入れてください";
  })();
  const canRecord = whyNotRecord === "";
  const plannedDiff = chosen && (v.amount ?? "").trim()
    ? Number(v.amount) - chosen.plannedAmount : null;

  /** 空のフォームの初期値。料率なら売上、定額なら検収を既定にする。 */
  function blank(): Record<string, string> {
    return {
      scheduleId: "", eventType: royalty && !rewardLabel ? "sales" : "inspection",
      occurredOn: new Date().toISOString().slice(0, 10),
      period: "", quantity: royalty && !rewardLabel ? "" : "1",
      grossAmount: "", deductions: "", amount: "", note: "",
      contractForm: "", serviceFrom: "", serviceTo: "",
      usageType: "", outConditionId: "", unitAmount: "", ratePct: defaultRatePct,
      paymentStage: "", basisKind: "per_unit",
      deliverable: "", inspectedOn: "", inspectorDept: "", inspectorName: ""
    };
  }

  function start(scheduleId?: number) {
    const next = blank();
    setV(next);
    setAdding(true); setError(null);
    if (scheduleId) applySchedule(String(scheduleId), next);
  }

  /** 回を選んだら、予定の値をそのまま入れる。ほとんどの回は予定どおりに済む。 */
  function applySchedule(id: string, base?: Record<string, string>) {
    const from = base ?? v;
    const line = schedules.find((s) => String(s.id) === id);
    if (!line) { setV({ ...from, scheduleId: "" }); return; }
    setV({
      ...from,
      scheduleId: id,
      occurredOn: line.dueOn ?? from.occurredOn ?? new Date().toISOString().slice(0, 10),
      amount: String(line.plannedAmount),
      period: line.label ?? from.period ?? "",
      eventType: typeByTrigger[line.triggerKind] ?? from.eventType ?? "inspection",
      inspectedOn: line.dueOn ?? from.inspectedOn ?? "",
      // 契約形式と役務提供期間は回が持っている。人が写し直さずに済ませる。
      contractForm: line.contractForm ?? from.contractForm ?? "",
      serviceFrom: line.serviceFrom ?? "",
      serviceTo: line.serviceTo ?? ""
    });
  }
  const pickSchedule = (id: string) => applySchedule(id);

  async function add() {
    setBusy(true); setError(null);
    try {
      const gross = f("grossAmount").trim();
      await api.post(`/conditions/${conditionId}/events`, {
        eventType: f("eventType"),
        occurredOn: f("occurredOn"),
        period: f("period").trim() || null,
        quantity: f("quantity").trim() ? Number(f("quantity")) : null,
        grossAmount: gross ? Math.round(Number(gross)) : null,
        deductions: f("deductions").trim() ? Math.round(Number(f("deductions"))) : 0,
        amount: Math.round(Number(f("amount") || 0)),
        note: f("note").trim() || null,
        contractForm: f("contractForm").trim() || null,
        serviceFrom: f("serviceFrom") || null,
        serviceTo: f("serviceTo") || null,
        usageType: f("usageType") || null,
        outConditionId: f("outConditionId") ? Number(f("outConditionId")) : null,
        unitAmount: f("unitAmount").trim() ? Math.round(Number(f("unitAmount"))) : null,
        // 画面は % で受け、保存は ppm（百万分率）。8% → 80000
        ratePpm: f("ratePct").trim() ? Math.round(Number(f("ratePct")) * 10000) : null,
        paymentStage: f("paymentStage") || null,
        scheduleId: f("scheduleId") ? Number(f("scheduleId")) : null,
        // 検収書がそのまま使う項目。空なら文書側で条件・案件から補う。
        deliverable: f("deliverable").trim() || null,
        inspectedOn: f("inspectedOn") || null,
        inspectorDept: f("inspectorDept").trim() || null,
        inspectorName: f("inspectorName").trim() || null
      });
      setAdding(false); load(); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  async function voidEvent(row: EventRow) {
    const reason = prompt(`実績 #${row.id}（${money(row.amount, currency)}）を取り消します。理由を書いてください。`);
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/conditions/${conditionId}/events/${row.id}/void`, { reason: reason.trim() });
      load(); onChanged();
    } catch (e) { setError((e as ApiError).message); }
    finally { setBusy(false); }
  }

  // 総額と控除を入れたら実額は決まる。入れ違いを起こさないよう先に見せる。
  const gross = Number(f("grossAmount") || 0);
  const deductions = Number(f("deductions") || 0);
  const derived = f("grossAmount").trim() ? gross - deductions : null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>実績</h2>
        <span className="faint">
          {rows.filter((r) => r.status === "active").length} 件
          {rows.some((r) => r.status === "void") &&
            `　（取消 ${rows.filter((r) => r.status === "void").length} 件を含む）`}
        </span>
        {editable && !adding && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => start()}>実績を足す</button>
        )}
      </div>

      {adding && (
        <div ref={addForm} className="panel-bd stack" style={{ borderBottom: "1px solid var(--line)" }}>
          {/* 予定がある条件は、どの回の分かを繋がないと検収書の支払日が空になる。
              予定の行の「実績にする」も、この欄を選んだ状態でここを開く。 */}
          {openSchedules.length > 0 && (
            <div className="form-grid">
            <label className="field wide">
              <span>どの回の分か</span>
              <select value={f("scheduleId")} onChange={(e) => pickSchedule(e.target.value)}>
                <option value="">（予定と結び付けない）</option>
                {openSchedules.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    第{s.seq}回　{s.label ?? "（名前なし）"}　
                    予定 {money(s.plannedAmount, currency)}
                    {s.dueOn ? `　期日 ${s.dueOn}` : ""}
                  </option>
                ))}
              </select>
              <small className={f("scheduleId") ? "faint" : "danger"}>
                {f("scheduleId")
                  ? "発生日・金額・種類・期間・契約形式は予定から入れました。違えば直してください"
                  : "結び付けないと、検収書の支払日が空欄になります"}
              </small>
            </label>
            </div>
          )}

          <div className="form-grid">
            <label className="field">
              <span>種類</span>
              <select value={f("eventType")} onChange={(e) => set("eventType", e.target.value)}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{inspecting ? "納品日" : "発生日"}</span>
              <input type="date" value={f("occurredOn")} onChange={(e) => set("occurredOn", e.target.value)} />
            </label>
            {royalty && !rewardLabel && (
              <label className="field">
                <span>対象期間</span>
                <input value={f("period")} placeholder="2026Q2 / 2026-06"
                       onChange={(e) => set("period", e.target.value)} />
              </label>
            )}
            {/*
              * 権利の使い方。利用許諾料計算書はこれで算定の形が決まる。
              *   自社製造・自社販売 … 基準価格 × 個数 × 料率（アウト条件なし）
              *   再許諾            … 受領価格 × 料率（アウト条件あり）
              *   自社製造・他社販売 … 受領価格 × 製造個数 × 料率（アウト条件あり）
              */}
            {canUse && (
              <label className="field">
                <span>利用形態</span>
                <select value={f("usageType")}
                  onChange={(e) => setV({
                    ...v,
                    // 形を変えたら、その形で使わない欄は消す。前の形の数字が
                    // 残ったまま保存されると、紙に出ない数字が実績に残る。
                    ...usageDefaults(e.target.value)
                  })}>
                  <option value="">（計算書を出さない実績）</option>
                  {usageTypes.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
                {usage && <small className="faint">{usage.hint}</small>}
              </label>
            )}
            {usage?.hasStages && (
              <label className="field">
                <span>入金区分</span>
                <select value={f("paymentStage")}
                  onChange={(e) => set("paymentStage", e.target.value)}>
                  <option value="">分けない（一括）</option>
                  {stages.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
                <small className="faint">
                  前金・後金に分かれる契約は、入金ごとに1件ずつ入れてください。
                  計算書には区分つきで2明細に出ます
                </small>
              </label>
            )}
            {usage?.choosableBasis && (
              <label className="field">
                <span>算定の形</span>
                <select value={f("basisKind")}
                  onChange={(e) => setV({
                    ...v, basisKind: e.target.value,
                    // 形を変えたら前の形の数字を消す。両方入った行は保存できない。
                    unitAmount: "", quantity: "", sampleQuantity: "", grossAmount: ""
                  })}>
                  <option value="per_unit">受領価格（1個あたり）× 製造個数</option>
                  <option value="lump">受領額そのもの（定額の前金など）</option>
                </select>
              </label>
            )}
            {usage?.needsOutCondition && (
              <label className="field" style={{ gridColumn: "1 / -1" }}>
                <span>許諾したアウト条件</span>
                <input value={outQuery} placeholder={`${workTitle ?? "作品"} の許諾を相手先名などで探す`}
                  onChange={(e) => setOutQuery(e.target.value)} />
                {!outFound.length && (
                  <small className="danger" style={{ marginTop: 4 }}>
                    {outTotal === 0
                      ? "許諾（OUT）の条件がまだ1件もありません。条件明細 → 条件を登録 で、向きを「OUT 許諾」にして作ってください"
                      : outQuery.trim()
                      ? `「${outQuery.trim()}」に当たる許諾がありません（許諾は全部で ${outTotal ?? "?"} 件）。言葉を変えるか、空にして一覧から選んでください`
                      : "候補を読み込んでいます"}
                  </small>
                )}
                <select value={f("outConditionId")} style={{ marginTop: 4 }}
                  onChange={(e) => {
                    const chosenOut = outFound.find((o) => String(o.id) === e.target.value);
                    // 受領価格は許諾したアウト条件が決めている。単価を持つ
                    // 条件なら入れておく（打ち直した値が契約と違っても気づけない）。
                    const price = usage?.value === "oem" && !lumpSum
                      && chosenOut?.pricingModel === "unit_rate"
                      ? asText(chosenOut.unitAmount) : null;
                    setV({ ...v, outConditionId: e.target.value,
                           ...(price ? { unitAmount: price } : {}) });
                  }}>
                  <option value="">（選んでください）</option>
                  {outFound.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.conditionNo ?? `#${o.id}`}　{o.partyName ?? "—"}　{o.name}
                    </option>
                  ))}
                </select>
                {pickedOut?.scopes
                  ? <small className="faint">許諾範囲：{pickedOut.scopes}（計算書に出ます）</small>
                  : outFound.length
                  ? <small className="faint">
                      {workTitle ? `${workTitle} の許諾を上に出しています。` : ""}
                      {outFound.length} 件（ほかの作品の許諾も選べます）。
                      無ければ 条件明細 → 条件を登録 で作ってから戻ってください
                    </small>
                  : null}
              </label>
            )}
            {usageField("unitAmount") && (
              <label className="field">
                <span>{usage?.value === "oem" ? "受領価格（1個あたり）" : "基準価格"}</span>
                <input inputMode="numeric" value={f("unitAmount")}
                  onChange={(e) => set("unitAmount", e.target.value)} />
                <small className="faint">税抜・{currency}</small>
              </label>
            )}
            {(!usage || usageField("quantity")) && (
              <label className="field">
                <span>{usage?.value === "oem" ? "製造個数" : "数量"}</span>
                <input inputMode="numeric" value={f("quantity")} onChange={(e) => set("quantity", e.target.value)} />
                {inspecting && !usage && (
                  <small className="faint">検収書の「今回数量」に出ます。1回分なら 1</small>
                )}
              </label>
            )}
            {usageField("sampleQuantity") && (
              <label className="field">
                <span>見本（無償分）</span>
                <input inputMode="numeric" value={f("sampleQuantity")}
                  onChange={(e) => set("sampleQuantity", e.target.value)} />
                <small className="faint">引いた数に料率が掛かります</small>
              </label>
            )}
            {usage && (
              <label className="field">
                <span>料率（%）</span>
                <input inputMode="numeric" value={f("ratePct")}
                  onChange={(e) => set("ratePct", e.target.value)} />
                <small className="faint">
                  {defaultRatePct
                    ? `イン条件の料率 ${defaultRatePct}% を入れています。特約の回だけ直してください`
                    : "イン条件に料率がありません。ここに入れるか、条件の料率を直してください"}
                </small>
              </label>
            )}
            <label className="field">
              <span>契約形式</span>
              <input list="contract-forms-event" value={f("contractForm")}
                     placeholder={chosen?.contractForm ?? "条件に合わせる"}
                     onChange={(e) => set("contractForm", e.target.value)} />
              <datalist id="contract-forms-event">
                {CONTRACT_FORMS.map((x) => <option key={x} value={x} />)}
              </datalist>
              <small className="faint">
                空なら予定の回・条件のものを使います。検収書の「契約種別」に出ます
              </small>
            </label>
            {/* 役務提供期間は定期払いの回のためのもの。毎月の顧問料は
                「何月分か」が金額と同じくらい大事で、名前の文字列だけでは
                締めのずれを確かめられない。 */}
            {(periodicRound || f("serviceFrom") || f("serviceTo")) && (
              <label className="field">
                <span>役務提供期間</span>
                <div className="row" style={{ gap: 5, flexWrap: "nowrap" }}>
                  <input type="date" value={f("serviceFrom")}
                         aria-label="役務提供期間の開始"
                         onChange={(e) => set("serviceFrom", e.target.value)} />
                  <span className="faint">〜</span>
                  <input type="date" value={f("serviceTo")}
                         aria-label="役務提供期間の終了"
                         onChange={(e) => set("serviceTo", e.target.value)} />
                </div>
                <small className="faint">終了日がその回の締め日です</small>
              </label>
            )}
            {usageField("grossAmount") && (
              <label className="field">
                <span>{lumpSum ? "受領額" : "受領価格"}</span>
                <input inputMode="numeric" value={f("grossAmount")}
                  onChange={(e) => set("grossAmount", e.target.value)} />
                <small className="faint">
                  相手から受け取った額（税抜・{currency}）。これに料率が掛かります
                </small>
              </label>
            )}
            {royalty && !rewardLabel && !usage && (
              <>
                <label className="field">
                  <span>報告売上・受領額（円）</span>
                  <input inputMode="numeric" value={f("grossAmount")}
                         onChange={(e) => set("grossAmount", e.target.value)} />
                  <small className="faint">
                    料率の条件では、ここが計算書の根拠になる。外貨は当社着金時のレートで円に直した額を入れる。ロイヤリティの額は計算書で計算する
                  </small>
                </label>
                <label className="field">
                  <span>控除</span>
                  <input inputMode="numeric" value={f("deductions")}
                         onChange={(e) => set("deductions", e.target.value)} />
                </label>
              </>
            )}
            {usage && (
              <div className="note" style={{ gridColumn: "1 / -1" }}>
                {usage.methodLabel}
                {f("paymentStage") && `　${stages.find((x) => x.value === f("paymentStage"))?.label}`}
                {pickedOut?.workTitle && `　製品名：${pickedOut.workTitle}`}
                {!pickedOut && workTitle && `　製品名：${workTitle}`}
                {pickedOut?.scopes && `　許諾範囲：${pickedOut.scopes}`}
              </div>
            )}
            {/* 利用形態のある実績は、実額を人が入れない。基礎 × 料率がそのまま
                作者に払う額なので、入れさせると紙と食い違う。ここには出る額を見せる。 */}
            {usage ? (
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <span>この実績の許諾料</span>
                <div className="num" style={{ fontSize: "1.15em", padding: "4px 0" }}>
                  {usageAmount === null
                    ? <span className="faint">数字が揃うと出ます</span>
                    : <b>{money(usageAmount, currency)}</b>}
                  {usageAmount !== null && (
                    <span className="faint" style={{ marginLeft: 8 }}>
                      {money(usageBasis ?? 0, currency)} × {f("ratePct")}%
                    </span>
                  )}
                </div>
                <small className="faint">保存するときにサーバでも計算し直します</small>
              </div>
            ) : (
            <label className="field">
              <span>{rewardLabel ?? "実額"}</span>
              <input inputMode="numeric" value={f("amount")} onChange={(e) => set("amount", e.target.value)} />
              {rewardLabel && (
                <small className="faint">
                  別で算定した結果を入れます。ここに入れた額がそのまま検収書の明細になります
                </small>
              )}
              {derived !== null && (
                <small className={String(derived) === f("amount").trim() ? "faint" : "danger"}>
                  総額 − 控除 = {money(derived, currency)}
                </small>
              )}
              {plannedDiff !== null && plannedDiff !== 0 && (
                <small className="danger">予定と差 {money(plannedDiff, currency)}</small>
              )}
            </label>
            )}
          </div>

          {/* 検収書がそのまま使う項目。ここに入れておけば文書を作るとき人が入れずに済む。 */}
          {inspecting && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="faint">検収書に載る項目（入れておくと文書を作るときに入力が要りません）</div>
              <div className="form-grid">
                <label className="field wide">
                  <span>成果物・業務内容</span>
                  <input value={f("deliverable")} placeholder="空なら条件の名前を使います"
                         onChange={(e) => set("deliverable", e.target.value)} />
                </label>
                <label className="field">
                  <span>検収日</span>
                  <input type="date" value={f("inspectedOn")}
                         onChange={(e) => set("inspectedOn", e.target.value)} />
                  <small className="faint">空なら納品日を使います</small>
                </label>
                <label className="field">
                  <span>検収者の部署</span>
                  <input value={f("inspectorDept")} placeholder="空なら案件の担当者から"
                         onChange={(e) => set("inspectorDept", e.target.value)} />
                </label>
                <label className="field">
                  <span>検収者の氏名</span>
                  <input value={f("inspectorName")} placeholder="空なら案件の担当者から"
                         onChange={(e) => set("inspectorName", e.target.value)} />
                </label>
              </div>
            </div>
          )}

          <div className="form-grid">
            <label className="field wide">
              <span>{rewardLabel ? "算定根拠" : "備考"}</span>
              <input value={f("note")} onChange={(e) => set("note", e.target.value)} />
              {rewardLabel && (
                <small className="faint">
                  検収書の明細に、料率と一緒にそのまま出ます（例: 上代1,500円 × 1,000部 × 8%）
                </small>
              )}
            </label>
          </div>
          {error && <div className="alert">{error}</div>}
          <div className="row">
            {/*
              * 押せない理由は必ず出す。利用形態のある実績は実額の欄が無い
              * （基礎 × 料率で出す）のに、実額が空だと押せないままだった。
              * 欄を消したのに、それを見ている判定を残していたので、押しても
              * 何も起きない画面になっていた。
              */}
            <button className="btn primary" disabled={busy || !canRecord}
                    onClick={() => void add()}>{busy ? "保存中…" : "記録する"}</button>
            {!canRecord && !busy && <span className="faint">{whyNotRecord}</span>}
            <button className="btn" disabled={busy} onClick={() => setAdding(false)}>やめる</button>
          </div>
        </div>
      )}

      {!adding && error && <div className="panel-bd"><div className="alert">{error}</div></div>}

      {issued && (
        <div className="panel-bd">
          <div className="note ok done-note">
            <div className="row">
              <b>決定しました</b>
              <span className="code">{issued.documentNo}</span>
              <span className="faint">実績に結び付けました</span>
            </div>
            <div className="row">
              {onOpenDocument && (
                <button className="btn primary btn-sm"
                        onClick={() => { const id = issued.id; setIssued(null); onOpenDocument(id); }}>
                  この文書を開く
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setIssued(null)}>閉じる</button>
            </div>
          </div>
        </div>
      )}

      {issuing && (
        <div ref={issueForm} className="panel-bd stack"
             style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row">
            <b>{label(issuing.eventType)}の実績から文書を作る</b>
            <span className="faint">
              {issuing.occurredOn ?? "—"}　{money(issuing.amount, currency)}
            </span>
          </div>
          <label className="field">
            <span>ひな形</span>
            <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              {templates.map((t) => (
                <option key={t.templateKey} value={t.templateKey}>
                  {t.category ? `${t.category}／${t.label}` : t.label}
                </option>
              ))}
            </select>
            <span className="faint">検収なら検収書、納品なら納品書</span>
          </label>

          {preview && preview.missing.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="note warn">
                このひな形は、条件と実績から決まらない項目を {preview.missing.length} つ要求します。
                埋めないと決定できません。
              </div>
              <div className="form-grid">
                {preview.missing.map((m) => (
                  <label key={m.name} className="field">
                    <span>{m.label}</span>
                    <input value={manual[m.name] ?? ""}
                           onChange={(e) =>
                             setManual((prev) => ({ ...prev, [m.name]: e.target.value }))} />
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="row">
            <button className="btn primary btn-sm" disabled={busy || !templateKey || !filled}
                    onClick={() => void issueDocument()}>作って決定する</button>
            <button className="btn btn-sm" onClick={() => { setIssuing(null); setPreview(null); }}>
              やめる
            </button>
            <span className="faint">
              {preview
                ? filled
                  ? `${preview.derived.length}項目を条件から自動で埋めます。決定すると番号が振られ、あとから中身は変えられません`
                  : `未入力 ${remaining} 件`
                : "ひな形の中身を確かめています…"}
            </span>
          </div>
        </div>
      )}

      {stmtDone && (
        <div className="panel-bd">
          <div className="note ok done-note">
            <div className="row">
              <b>計算書を決定しました</b>
              <span className="code">{stmtDone.documentNo}</span>
              <span className="faint">選んだ実績に結び付け、金額は決定のときに計算し直しました</span>
            </div>
            <div className="row">
              {onOpenDocument && (
                <button className="btn primary btn-sm"
                        onClick={() => { const id = stmtDone.id; setStmtDone(null); onOpenDocument(id); }}>
                  この文書を開く
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setStmtDone(null)}>閉じる</button>
            </div>
          </div>
        </div>
      )}

      {/* 選んだ実績から書類を作る。料率なら計算書、定額なら検収書・納品書。
          業績連動の業務委託は金額がもう決まっているので計算書には行かない。
          報酬計算書のひな形は作らず、検収書の明細に内訳として載せる。 */}
      {editable && rows.some((r) => r.status === "active" && !r.documentId) && (
        <div className="panel-bd row" style={{ borderBottom: "1px solid var(--line)", gap: 8 }}>
          <span className="faint">
            {pickedIds.length ? `${pickedIds.length} 件を選択中` : "左の四角で実績を選ぶと、まとめて1枚の書類にできます"}
          </span>
          {royalty && !rewardLabel ? (
            <button className="btn btn-sm primary" disabled={!pickedIds.length || stmtOpen}
                    onClick={() => { setStmtOpen(true); setStmtDone(null); }}>
              選んだ {pickedIds.length} 件で計算書を作る
            </button>
          ) : (
            <button className="btn btn-sm primary" disabled={!pickedIds.length}
                    onClick={() => onCompose?.([conditionId], pickedIds, matterId ?? null)}>
              選んだ {pickedIds.length} 件で文書を作る
            </button>
          )}
          {rewardLabel && (
            <span className="faint">{rewardLabel}は検収書の明細に内訳として出ます（計算書は作りません）</span>
          )}
          {pickedIds.length > 0 && (
            <button className="linky" onClick={() => setPicked(new Set())}>選択を外す</button>
          )}
        </div>
      )}

      {stmtOpen && (
        <div className="panel-bd stack" style={{ borderBottom: "1px solid var(--line)" }}>
          <div className="row">
            <b>選んだ実績の束から計算書を作る</b>
            <span className="faint">
              {rows.some((r) => picked.has(r.id) && r.usageType)
                ? "明細は実績1件が1行。行ごとに 基礎 × 料率 を出して足す（MG・AG は合計にだけ効く）"
                : "根拠（報告売上・数量）を合算して1回だけ計算し、明細は実績1件が1行。額は根拠の比で按分"}
            </span>
          </div>
          <div className="form-grid">
            <label className="field">
              <span>ひな形</span>
              <select value={stmtTemplate} onChange={(e) => setStmtTemplate(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.templateKey} value={t.templateKey}>
                    {t.category ? `${t.category}／${t.label}` : t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>対象期間</span>
              <input value={stmtPeriod} placeholder={stmtPreview?.period ?? "実績から導く"}
                     onChange={(e) => setStmtPeriod(e.target.value)} />
              <small className="faint">空なら実績の期間（揃っていなければ最古〜最新）</small>
            </label>
          </div>
          {stmtPreview && (
            <table>
              <tbody>
                {stmtPreview.events.map((e) => (
                  <tr key={e.eventId}>
                    <td className="code">{e.occurredOn ?? "—"}</td>
                    <td>{label(e.eventType)}</td>
                    <td className="num">{money(e.basis, currency)}</td>
                    <td className="faint">{Math.round(e.share * 1000) / 10}%</td>
                  </tr>
                ))}
                <tr><td><b>根拠の合計</b></td><td></td>
                    <td className="num"><b>{money(stmtPreview.reported.salesInput ?? stmtPreview.reported.quantity ?? 0, currency)}</b></td>
                    <td className="faint">期間 {stmtPreview.period}{stmtPreview.appliedVersion?.switched ? `／${stmtPreview.appliedVersion.conditionNo} の版で計算` : ""}</td></tr>
                <tr><td>グロス</td><td></td><td className="num">{money(stmtPreview.fee.gross_ex_tax, currency)}</td>
                    <td className="faint">{stmtPreview.fee.formula_breakdown}</td></tr>
                <tr><td>MG 上乗せ／AG 相殺</td><td></td>
                    <td className="num">{money(stmtPreview.fee.mg_topup_this_time, currency)}／−{money(stmtPreview.fee.ag_offset_this_time, currency)}</td>
                    <td className="faint">明細には割らず、合計にだけ効く</td></tr>
                <tr><td><b>税抜実額</b></td><td></td><td className="num"><b>{money(stmtPreview.fee.actual_ex_tax, currency)}</b></td>
                    <td className="faint">消費税 {money(stmtPreview.fee.tax_amount, currency)}
                      {stmtPreview.payment.withholdingEnabled ? `／源泉 ${money(stmtPreview.payment.withholdingTax, currency)}` : ""}</td></tr>
              </tbody>
            </table>
          )}
          <div className="row">
            <button className="btn primary btn-sm" disabled={stmtBusy || !stmtPreview || !stmtTemplate}
                    onClick={() => void issueStatement()}>
              {stmtBusy ? "決定しています…" : "計算書を決定する"}
            </button>
            <button className="btn btn-sm" onClick={() => { setStmtOpen(false); setStmtPreview(null); }}>やめる</button>
            <span className="faint">決定すると番号が振られ、選んだ実績はこの計算書に結ばれます</span>
          </div>
        </div>
      )}

      <div className="tablewrap">
        <table>
          <thead><tr>
            <th></th><th>発生日</th><th>種類</th><th>期間</th>
            {canUse && <th>利用形態 ／ 許諾先</th>}
            <th className="num">数量</th>
            <th className="num">実額</th><th>出どころ</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const voided = row.status === "void";
              return (
                <tr key={row.id} style={voided ? { opacity: 0.6 } : undefined}>
                  <td>
                    {editable && !voided && !row.documentId && (
                      <input type="checkbox" checked={picked.has(row.id)} aria-label={`実績 ${row.occurredOn ?? row.id} を選ぶ`}
                             onChange={(e) => setPicked((prev) => {
                               const next = new Set(prev);
                               if (e.target.checked) next.add(row.id); else next.delete(row.id);
                               return next;
                             })} />
                    )}
                  </td>
                  <td className="code">{row.occurredOn ?? "—"}</td>
                  <td>{label(row.eventType)}
                    {voided && <span className="tag out" style={{ marginLeft: 5 }}>取消</span>}</td>
                  <td className="faint">
                    {row.period ?? "—"}
                    {/* どの回に繋がっているか。繋がっていない実績は検収書の支払日が空になる。 */}
                    {row.scheduleId
                      ? <div className="tag">{row.scheduleLabel ?? "予定あり"}</div>
                      : null}
                  </td>
                  {canUse && (
                    <td>
                      {row.usageLabel ?? <span className="faint">—</span>}
                      {row.paymentStageLabel && (
                        <span className="tag" style={{ marginLeft: 5 }}>{row.paymentStageLabel}</span>
                      )}
                      {row.outConditionNo && (
                        <div className="faint">{row.outConditionNo}　{row.outConditionName}</div>
                      )}
                      {row.ratePpm !== null && row.ratePpm !== undefined && (
                        <div className="faint">
                          {row.unitAmount ? `${money(row.unitAmount, currency)} × ` : ""}
                          料率 {row.ratePpm / 10000}%
                        </div>
                      )}
                    </td>
                  )}
                  <td className="num">{row.quantity ?? "—"}</td>
                  <td className="num" style={voided ? { textDecoration: "line-through" } : undefined}>
                    {money(row.amount, currency)}
                    {row.deductions ? <div className="faint">控除 {money(row.deductions, currency)}</div> : null}
                  </td>
                  <td className="faint">
                    {row.documentNo
                      ? <>文書 <span className="code">{row.documentNo}</span></>
                      : row.createdBy}
                  </td>
                  <td>
                    {editable && !voided && !row.documentId && (
                      <button className="btn btn-sm" disabled={busy}
                              onClick={() => void voidEvent(row)}>取り消す</button>
                    )}
                    {editable && !voided && !row.documentId && (
                      <button className="btn btn-sm" style={{ marginLeft: 5, whiteSpace: "nowrap" }}
                              onClick={() => {
                                // 作成のフォームは「文書」画面に1本化してある。
                                // ここからはその画面へ、条件と実績を選んだ状態で移る。
                                if (onCompose) onCompose([conditionId], [row.id], matterId ?? null);
                                else { setIssuing(row); setIssued(null); }
                              }}>
                        文書を作る
                      </button>
                    )}
                    {row.documentId && !voided && (
                      <span className="faint" style={{ whiteSpace: "nowrap" }}>文書あり</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={8} className="faint">
                実績がありません。製造数・売上・検収などをここに記録します。
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.some((r) => r.note) && (
        <div className="panel-bd">
          {rows.filter((r) => r.note).map((r) => (
            <div key={r.id} className="faint">#{r.id}：{r.note}</div>
          ))}
        </div>
      )}
    </div>
  );
}
