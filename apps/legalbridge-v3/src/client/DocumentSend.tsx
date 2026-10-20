import { useEffect, useState } from "react";
import { api, ApiError } from "./api.js";
import { CloudSignManual } from "./CloudSignManual.js";
import { RecipientPicker, type Person } from "./RecipientPicker.js";
import { ProcessRail, stationStateOf, type Station, type StationTag } from "./ProcessRail.js";
import { replaceRouteParams } from "./route.js";
import { OwnerStaffPicker } from "./OwnerStaffPicker.js";
import type { NoticeTarget } from "../server/documents/notice-fill.js";
import { MAIL_PURPOSES, type MailPurpose } from "../server/ops/mail-templates.js";

/**
 * 決定した文書を「送る」。本線の 5 駅のうち ②〜⑤ を縦の工程表で出す。
 *
 *   ② 決定　　　　… 番号が付いた
 *   ③ 担当者確認　… 事業部の担当者に社内確認メール（飛ばせる）
 *   ③ 相手方確認　… 相手に内容確認メール → 返事を記録（飛ばせる）
 *   ④ 送付　　　　… メールで送付 ／ CloudSign で署名依頼 ／ システム外で送ったと記録
 *   ⑤ 締結　　　　… CloudSign の結果か手の記録（契約書だけ。飛ばせる）
 *
 * どこまで済んで次が何かは左の工程表に、やることは右に。飛ばした工程は理由つきで残る。
 * 送れなかったときは理由をそのまま見せる。
 */

type StepKey = "decided" | "owner_check" | "party_check" | "send" | "executed" | "notice";
interface Step {
  key: StepKey; station: number; name: string; done: boolean; at: string | null; detail: string;
  skipped: boolean; skipReason: string | null; skippable: boolean; optional?: boolean; passed?: boolean; pending?: string | null;
}
interface Timeline {
  steps: Step[]; current: Step | null;
  events: Array<{ at: string; action: string; actor: string; detail: Record<string, unknown> }>;
  hasAgreement?: boolean; needsExecution: boolean;
}
interface DocRecipients {
  counterparty: { id: number | null; name: string; email: string | null } | null;
  contacts: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  signers: Array<{ name: string | null; email: string; roles: string[]; department: string | null }>;
  signersFrom: "signer" | "primary" | null;
  requester: Person | null;
  owner: Person | null;
  origin: { label: string; no: string | null; title: string | null } | null;
}

/**
 * 送っている最中の印。メールは PDF を作って添付するので 10〜20 秒かかることがあり、
 * 何も出ないと「反応しない」と思って連打される。回る輪と経過秒を出し、ボタンは押せなくする。
 */
function Sending({ what }: { what: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setSec((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="sending" role="status" aria-live="polite">
      <span className="spin" />
      <span>
        <b>{what}</b>　{sec} 秒経過。PDF を作って送っているので、しばらくお待ちください（二度押しは要りません）
      </span>
    </div>
  );
}
interface Outcome { sent: boolean; duplicated?: boolean; draft?: boolean; warnings?: string[]; externalId?: string; gate: { reasons: string[]; mode: string };
                    preview?: { recipient: string; bodyPreview: string } }

type Purpose = MailPurpose;
interface Draft {
  to: Array<{ name: string | null; email: string }>; cc: Array<{ name: string | null; email: string }>;
  subject: string; body: string; warnings: string[];
}
/** 決まった文面。設定で足した文面（custom:<key>）は /mail-purposes から足す。 */
const PURPOSES: Array<{ value: Purpose; label: string; hint: string }> = MAIL_PURPOSES;
/** 各段で最初に入れておく文面。 */
const DEFAULT_PURPOSE: Partial<Record<StepKey, Purpose>> = { owner_check: "owner_check", party_check: "party_check", send: "delivery" };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const STATION = ["", "登録", "作る", "確かめる", "送る", "記録する"];
const ACTION_LABEL: Record<string, string> = {
  "document.issue": "決定", "gmail.review": "担当者へ社内確認メール", "gmail.send": "メールで送付",
  "gmail.party_check": "相手へ内容確認メール", "gmail.blocked": "メールを送れなかった", "document.confirmed": "相手の確認をもらった",
  "document.sent_manual": "システム外で送付（記録）", "document.step_skipped": "工程を飛ばした",
  "cloudsign.draft": "CloudSign に下書き", "cloudsign.send": "CloudSign で署名依頼", "cloudsign.applied": "CloudSign の結果",
  "cloudsign.blocked": "CloudSign に送れなかった"
};
const STEP_LABEL: Record<string, string> = { owner_check: "担当者確認", party_check: "相手方確認", executed: "締結" };

/** 工程を飛ばす。理由は任意。記録に残る。 */
function SkipBox({ step, busy, onSkip }: { step: Step; busy: boolean; onSkip: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!step.skippable || step.done || step.skipped) return null;
  if (!open) return <button className="btn" style={{ borderStyle: "dashed" }} disabled={busy} onClick={() => setOpen(true)}>この工程を飛ばす</button>;
  return (
    <div className="note stack" style={{ gap: 6 }}>
      <div><b>{step.name}を飛ばす</b>（記録に残り、工程表に「飛ばした」と出ます）</div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input value={reason} placeholder="理由（任意。電話で確認済み など）" style={{ minWidth: 300 }}
               onChange={(e) => setReason(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={() => { onSkip(reason); setOpen(false); }}>飛ばして次へ</button>
        <button className="linky" onClick={() => setOpen(false)}>やめる</button>
      </div>
    </div>
  );
}

export function DocumentSend(
  { documentId, documentNo, templateLabel, matterId, channels, isAdmin, onChanged, onClose, initialOpen }: {
    documentId: number; documentNo: string | null; templateLabel: string | null;
    matterId: number | null;
    channels: Array<{ channel: string; mode: "off" | "dry_run" | "live"; configured: boolean }>;
    isAdmin: boolean;
    onChanged: () => void;
    onClose: () => void;
    /** 最初に開く段（URL の ?step=）。 */
    initialOpen?: string | null;
  }
) {
  const [tl, setTl] = useState<Timeline | null>(null);
  const [docRecipients, setDocRecipients] = useState<DocRecipients | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** いま送っているもの（印の文言）。 */
  const [sendingWhat, setSendingWhat] = useState<string | null>(null);
  const STEP_KEYS: StepKey[] = ["decided", "owner_check", "party_check", "send", "executed", "notice"];
  const [open, setOpenState] = useState<StepKey | null>(
    initialOpen && (STEP_KEYS as string[]).includes(initialOpen) ? (initialOpen as StepKey) : null);
  /** 段を開く。URL の ?step= にも写す（リンクを貼ればその段が開く）。 */
  const setOpen = (next: StepKey | null | ((prev: StepKey | null) => StepKey | null)) => {
    setOpenState((prev) => {
      const v = typeof next === "function" ? next(prev) : next;
      replaceRouteParams({ step: v });
      return v;
    });
  };
  /** ④ 送付のやり方。契約書は CloudSign、それ以外はメールを先に出す。 */
  const [sendWay, setSendWay] = useState<"mail" | "cloudsign" | null>(null);
  // メール
  // 宛先。下書きが入れた相手に、取引先の連絡先・自社の人を探して足せる（To / Cc）。
  const [mailTo, setMailTo] = useState<Record<string, Person[]>>({ to: [], cc: [] });
  const to = mailTo.to ?? [];
  const cc = mailTo.cc ?? [];
  /**
   * 一緒に添える文書（同じ相手先の決定済みの文書）。基本契約と個別契約を一度に送るなど。
   * 選んでいれば 1 通・複数添付で送る（/documents/send-many。相手先が違えば断られる）。
   */
  const [extras, setExtras] = useState<number[]>([]);
  const [siblings, setSiblings] = useState<Array<{ id: number; documentNo: string | null; templateLabel: string | null;
    title: string | null; phase?: string; issuedAt: string | null }>>([]);
  const [siblingFilter, setSiblingFilter] = useState("");
  const [subject, setSubject] = useState(`${documentNo ?? ""} ${templateLabel ?? "文書"} のご確認`.trim());
  const [body, setBody] = useState(
    `${templateLabel ?? "文書"}をお送りします。内容をご確認のうえ、問題なければご返信ください。`);
  // 文面（設定の mail_templates から組んだ下書き）。どの段で組んだかも覚える（段を替えたら組み直す）。
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  /** 文面の選択肢（決まったもの＋設定で足したもの）。 */
  const [purposes, setPurposes] = useState<Array<{ value: Purpose; label: string; hint: string }>>(PURPOSES);
  useEffect(() => {
    api.get<{ purposes: Array<{ value: Purpose; label: string; hint: string }> }>("/mail-purposes")
      .then((r) => setPurposes(r.purposes)).catch(() => setPurposes(PURPOSES));
  }, []);
  const [draftFor, setDraftFor] = useState<StepKey | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // 確認
  const [via, setVia] = useState("メールの返信");
  const [confirmNote, setConfirmNote] = useState("");
  // CloudSign。署名者は複数（並べた順に署名）、確認者・CC は署名せず見るだけ。
  const [sign, setSign] = useState<Record<string, Person[]>>({ signers: [], reportees: [] });
  const [signNote, setSignNote] = useState<string | null>(null);
  const signer = sign.signers[0]?.email ?? "";
  const [historyOpen, setHistoryOpen] = useState(false);

  const modeOf = (ch: string) => channels.find((c) => c.channel === ch)?.mode ?? "off";

  /**
   * ③ 確かめる の札「担当者・通知先」。通知先の欄のある契約書（基本契約書・条件書）で、
   * 甲の通知先・乙（当社）の担当者が空いていないか。空いていれば、ここから訂正版で出し直す
   * （まとめて直すのは 運用 › 一括修正 › 通知先。同じ道具）。
   */
  type NoticeCheck = { applies: boolean; filled: boolean; target: NoticeTarget | null; staff: string | null };
  const [notice, setNotice] = useState<NoticeCheck | null>(null);
  const [noticeStaff, setNoticeStaff] = useState<number | null>(null);
  const loadNotice = (staffId: number | null) =>
    api.get<NoticeCheck>(`/documents/${documentId}/notice-check${staffId ? `?ownerStaffId=${staffId}` : ""}`)
      .then(setNotice).catch(() => setNotice(null));
  useEffect(() => { void loadNotice(noticeStaff); }, [documentId, noticeStaff]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const t = await api.get<Timeline>(`/documents/${documentId}/sends`);
    setTl(t);
    setOpen((prev) => prev ?? t.current?.key ?? "send");
    setSendWay((prev) => prev ?? (t.needsExecution ? "cloudsign" : "mail"));
  }
  useEffect(() => {
    setError(null);
    load().catch((e: ApiError) => setError(e.message));
    // 署名者の候補。取引先の署名者（無ければ主担当）を入れておき、違えば外す。
    api.get<DocRecipients>(`/documents/${documentId}/recipients`).then((r) => {
      setDocRecipients(r);
      setSign((prev) => {
        if (prev.signers.length || !r.signers.length) return prev;
        return { ...prev, signers: r.signers.map((c) => ({ email: c.email, name: c.name })) };
      });
      setSignNote(r.signers.length
        ? `署名者に取引先の${r.signersFrom === "signer" ? "署名者" : "主担当"}を入れておきました。違えば外してください`
        : r.counterparty ? "取引先に署名者・主担当の連絡先が無いので、探して足してください"
        : "この文書は取引先が決まっていません。署名者を探して足してください");
    }).catch(() => undefined);
  }, [documentId]);

  // 同じ相手先の決定済みの文書。送る文書そのものと、差し替えられた古い版は出さない。
  useEffect(() => {
    const partyId = docRecipients?.counterparty?.id;
    if (!partyId) { setSiblings([]); return; }
    api.get<{ documents: typeof siblings }>(`/documents?partyId=${partyId}&status=issued`)
      .then((r) => setSiblings(r.documents.filter((d) => d.id !== documentId)))
      .catch(() => setSiblings([]));
  }, [docRecipients?.counterparty?.id, documentId]);

  async function loadDraft(p: Purpose) {
    setError(null);
    try {
      const d = await api.get<Draft>(`/documents/${documentId}/mail-draft?purpose=${p}`);
      setPurpose(p);
      setMailTo({ to: d.to.map((x) => ({ email: x.email, name: x.name })), cc: d.cc.map((x) => ({ email: x.email, name: x.name })) });
      setSubject(d.subject); setBody(d.body); setWarnings(d.warnings);
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  }
  // 段を開いたら、その段の文面を入れておく（担当者確認は担当者への確認、相手方確認は取引先への内容確認、送付は送付）。
  useEffect(() => {
    if (!open || !DEFAULT_PURPOSE[open] || draftFor === open) return;
    if (open === "send" && sendWay !== "mail") return;
    setDraftFor(open);
    void loadDraft(DEFAULT_PURPOSE[open]!);
  }, [open, sendWay]);

  const describe = (o: Outcome, what: string) => describeBase(o, what)
    + (o.warnings?.length ? `\n⚠ ${o.warnings.join("\n⚠ ")}` : "");
  const describeBase = (o: Outcome, what: string) =>
    o.sent && o.draft ? `${what}を CloudSign に下書きとして作りました${o.externalId ? `（書類ID ${o.externalId}）` : ""}。送信は CloudSign の画面から行い、送ったら手で「送った」と記録してください`
      : o.sent ? `${what}を送りました`
      : o.duplicated ? `同じ宛先・同じ内容の${what}をすでに作っています（二度は作りません）。宛先を変えたなら、変えた内容で作り直されます`
      : o.preview ? `検証モードのため送っていません。送るなら：${o.preview.recipient} へ`
      : `送りませんでした：${o.gate.reasons.join("／")}`;

  async function run(fn: () => Promise<string>, what: string | null = null) {
    if (busy) return;   // 連打しても二度は送らない
    setBusy(true); setSendingWhat(what); setError(null); setNote(null);
    try {
      const message = await fn();
      setNote(message);
      // 段が進んだら「いま」を開き直す。
      const t = await api.get<Timeline>(`/documents/${documentId}/sends`);
      setTl(t);
      setOpen(t.current?.key ?? "executed");
      onChanged();
    }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
    finally { setBusy(false); setSendingWhat(null); }
  }

  const internal = open === "owner_check";
  const sendMail = () => run(async () => {
    const mail = { to: to.map((p) => p.email), cc: cc.map((p) => p.email), subject, body, attachPdf: true, internal };
    // 添える文書があれば 1 通にまとめて送る（各文書に「送った」が残る）。
    const r = extras.length
      ? await api.post<{ outcome: Outcome }>("/documents/send-many", {
          ...mail, documentIds: [documentId, ...extras], recordAs: purpose === "contract_unify" ? "party_check" : "sent" })
      : await api.post<{ outcome: Outcome }>(`/documents/${documentId}/send`, mail);
    return describe(r.outcome, internal ? "社内確認のメール" : open === "party_check" ? "内容確認のメール" : "送付のメール");
  }, "メールを送っています");
  const confirm = () => run(async () => {
    await api.post(`/documents/${documentId}/confirm`, { via, note: confirmNote || null });
    setConfirmNote("");
    return "相手の確認を記録しました";
  });
  const skip = (step: StepKey, reason: string) => run(async () => {
    await api.post(`/documents/${documentId}/skip`, { step, reason: reason.trim() || null });
    return `${STEP_LABEL[step] ?? step}を飛ばしました`;
  });
  const requestSign = () => run(async () => {
    const r = await api.post<{ outcome: Outcome }>(`/documents/${documentId}/sign`, {
      signers: sign.signers.map((p) => ({ email: p.email, name: p.name ?? null })),
      reportees: sign.reportees.map((p) => ({ email: p.email, name: p.name ?? null }))
    });
    return describe(r.outcome, "CloudSign の署名依頼");
  }, "CloudSign に下書きを作っています");

  /** 候補を欄に足す（同じ人は二度入れない。署名者と確認者の両方にも入れない）。 */
  const addPerson = (key: "signers" | "reportees", p: Person) => {
    setSign((prev) => {
      const same = (x: Person) => x.email.toLowerCase() === p.email.toLowerCase();
      if ((prev[key] ?? []).some(same)) return prev;
      const other = key === "signers" ? "reportees" : "signers";
      return { ...prev, [other]: (prev[other] ?? []).filter((x) => !same(x)), [key]: [...(prev[key] ?? []), p] };
    });
  };

  const stepOf = (key: StepKey) => tl?.steps.find((s) => s.key === key) ?? null;
  const opened = open ? stepOf(open) : null;


  const sub = (s: Step) => {
    const current = tl?.current?.key === s.key;
    if (s.done) return `済 ${day(s.at)}　${s.detail}`;
    if (s.skipped) return s.detail;
    if (s.pending) return s.pending;
    if (s.passed) return "通らずに先へ進んだ";
    if (s.optional) return "この文書には要らない";
    return current ? "いま" : s.skippable ? "未（飛ばせる）" : "未";
  };

  /** 工程ナビ。段（決定・担当者確認・相手方確認・送付・締結）を駅 ②〜⑤ の札にする。① 登録は台帳（済）。 */
  const railStations: Station[] = (() => {
    if (!tl) return [];
    const tagOf = (s: Step): StationTag => ({
      key: s.key, label: s.name, open: open === s.key, title: sub(s),
      state: s.done ? "done" : s.skipped ? "skipped" : tl.current?.key === s.key ? "now" : s.optional ? "optional" : "todo",
      onGo: () => setOpen(s.key)
    });
    const station = (no: 2 | 3 | 4 | 5, skippable = false): Station => {
      const steps = tl.steps.filter((s) => s.station === no);
      const tags = steps.map(tagOf);
      if (no === 3 && notice?.applies) {
        tags.push({ key: "notice", label: "担当者・通知先", open: open === "notice",
          state: notice.filled ? "done" : "now",
          title: notice.filled ? "通知先・担当者は入っています" : "通知先か担当者の欄が空いています",
          onGo: () => setOpen("notice") });
      }
      const first = steps.find((s) => !s.done && !s.skipped) ?? steps[0];
      return { no, state: stationStateOf(tags), tags, skippable, open: steps.some((s) => s.key === open),
               onGo: first ? () => setOpen(first.key) : undefined,
               detail: steps.length === 1 && steps[0]!.done ? `済 ${day(steps[0]!.at)}` : undefined };
    };
    return [
      { no: 1, state: "done", detail: "条件・契約（台帳）" },
      station(2), station(3, true), station(4), station(5, true)
    ];
  })();

  const mailForm = () => (
    <div className="stack" style={{ gap: 8 }}>
      {modeOf("gmail") !== "live" && (
        <div className="note warn">メール送信は{modeOf("gmail") === "dry_run" ? "検証モード（送らずに宛先と本文を確かめる）" : "無効"}です</div>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <span className="faint">文面：</span>
        {purposes.map((p) => (
          <button key={p.value} className="chip" aria-pressed={purpose === p.value} title={p.hint}
                  disabled={busy} onClick={() => void loadDraft(p.value)}>{p.label}</button>
        ))}
      </div>
      <div className="faint">宛先・件名・本文は、運用 → 設定 → 「メールの文面」から組みます。送る前にここで直せます。</div>
      {warnings.map((w) => <div key={w} className="note warn">{w}</div>)}
      {internal && <div className="note">社内確認として送ります（宛先は当社の担当者。相手先にはまだ送っていない扱いで、送ると担当者確認が済になります）</div>}
      <RecipientPicker value={mailTo} onChange={setMailTo}
        initialKeyword={docRecipients?.counterparty?.name ?? ""}
        fields={[
          { key: "to", label: "To" },
          { key: "cc", label: "Cc", hint: "写し。事業部の担当者・経理などを足せます" }
        ]} />
      <div className="frow"><div className="flabel"><span>件名</span></div>
        <div className="fbody"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></div></div>
      <div className="frow"><div className="flabel"><span>本文</span></div>
        <div className="fbody"><textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="faint" style={{ marginTop: 3 }}>
            {[documentNo ?? "この文書", ...extras.map((id) => siblings.find((d) => d.id === id)?.documentNo ?? `#${id}`)].join("・")} の PDF を添えます
          </div></div></div>
      <div className="frow"><div className="flabel"><span>一緒に添える文書</span></div>
        <div className="fbody stack" style={{ gap: 4 }}>
          {!docRecipients?.counterparty?.id
            ? <span className="faint">この文書は相手先が決まっていないので、ほかの文書を添えられません</span>
            : !siblings.length
            ? <span className="faint">同じ相手先の決定済みの文書はほかにありません</span>
            : (<>
              <input value={siblingFilter} placeholder="文書番号・種類・件名で絞る（基本契約書 など）"
                     onChange={(e) => setSiblingFilter(e.target.value)} />
              <div className="picker" style={{ maxHeight: 180, overflowY: "auto" }}>
                {siblings
                  .filter((d) => !siblingFilter.trim() || `${d.documentNo ?? ""} ${d.templateLabel ?? ""} ${d.title ?? ""}`
                    .toLowerCase().includes(siblingFilter.trim().toLowerCase()) || extras.includes(d.id))
                  .slice(0, 50)
                  .map((d) => (
                    <label key={d.id} className="row" style={{ gap: 6, padding: "2px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={extras.includes(d.id)}
                             onChange={(e) => setExtras((x) => e.target.checked ? [...x, d.id] : x.filter((y) => y !== d.id))} />
                      <span className="code">{d.documentNo ?? `#${d.id}`}</span>
                      <span>{d.templateLabel ?? "文書"}</span>
                      <span className="faint">{d.title ?? ""}{d.issuedAt ? `（${d.issuedAt.slice(0, 10)}）` : ""}</span>
                    </label>
                  ))}
              </div>
              <small className="faint">同じ相手先の決定済みの文書から選べます（基本契約と個別契約を一緒に送るなど）。選ぶと 1 通に PDF を並べて送り、添えた文書にも同じ記録が残ります</small>
            </>)}
        </div></div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" disabled={busy || !to.length || !subject.trim() || !body.trim()}
                aria-busy={busy} onClick={() => void sendMail()}>
          {busy ? "送っています…" : internal ? "社内確認で送る" : open === "party_check" ? "内容確認のメールを送る" : "メールで送付する"}
        </button>
        {opened && <SkipBox step={opened} busy={busy} onSkip={(r) => void skip(opened.key, r)} />}
      </div>
    </div>
  );

  const cloudSignPane = () => (
    <div className="stack" style={{ gap: 8 }}>
      {modeOf("cloudsign") !== "live" && (
        <div className="note warn">CloudSign は{modeOf("cloudsign") === "dry_run" ? "検証モード（送らずに宛先を確かめる）" : "無効"}です</div>
      )}
      {!isAdmin && <div className="note warn">署名依頼は admin だけが送れます</div>}
      {signNote && <div className="faint">{signNote}</div>}
      {/* 候補から一押しで足す。取引先の署名者、事業部の担当者（依頼者）、法務の担当。 */}
      {docRecipients && (
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          <span className="faint">候補：</span>
          {docRecipients.contacts.map((c) => (
            <span key={c.email} className="row" style={{ gap: 2 }}>
              <span className="src suggested">{docRecipients.counterparty?.name ?? "取引先"}</span>
              <span style={{ fontSize: 12 }}>{c.name ?? c.email}{c.roles.includes("signer") ? "（署名者）" : c.roles.includes("primary") ? "（主担当）" : ""}</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("signers", { email: c.email, name: c.name })}>署名者</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", { email: c.email, name: c.name })}>CC</button>
            </span>
          ))}
          {docRecipients.requester && (
            <span className="row" style={{ gap: 2 }}>
              <span className="src auto">事業部担当</span>
              <span style={{ fontSize: 12 }}>{docRecipients.requester.name ?? docRecipients.requester.email}</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", docRecipients.requester!)}>CC</button>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("signers", docRecipients.requester!)}>署名者</button>
            </span>
          )}
          {docRecipients.owner && (
            <span className="row" style={{ gap: 2 }}>
              <span className="src auto">法務担当</span>
              <span style={{ fontSize: 12 }}>{docRecipients.owner.name ?? docRecipients.owner.email}</span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => addPerson("reportees", docRecipients.owner!)}>CC</button>
            </span>
          )}
        </div>
      )}
      <RecipientPicker value={sign} onChange={setSign}
        initialKeyword={docRecipients?.counterparty?.name ?? ""}
        fields={[
          { key: "signers", label: "署名者", hint: "並べた順に署名を求めます。1人以上。取引先の署名者と当社の署名者を入れます" },
          { key: "reportees", label: "確認者・CC", hint: "署名はしませんが、書類を見られます（事業部の担当者など）" }
        ]} />
      <div className="faint">{documentNo ?? "この文書"} の PDF を CloudSign に<b>下書き</b>として載せます（相手にはまだ届きません）。CloudSign の画面で確かめてから送り、送ったら下の「手で記録する」で「送った」と残します。結果が届くと「締結」が済になります</div>
      <div className="row">
        <button className="btn primary" disabled={busy || !isAdmin || sign.signers.length === 0}
                aria-busy={busy} onClick={() => void requestSign()}>
          {busy ? "作っています…" : `CloudSign に下書きを作る（署名者 ${sign.signers.length} 人${sign.reportees.length ? `・CC ${sign.reportees.length} 人` : ""}）`}
        </button>
      </div>
      {/* 予備系では連携が無い。CloudSign の画面から直接送ったぶんを、ここで手で記録する。 */}
      <details open={modeOf("cloudsign") !== "live"} style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
        <summary style={{ cursor: "pointer" }}>システム外（CloudSign の画面から直接・郵送など）で送った・結果が届いたときは、手で記録する</summary>
        <div style={{ marginTop: 8 }}>
          <CloudSignManual documentId={documentId} documentNo={documentNo} initial="sent"
            defaultSigner={signer} hasAgreement={tl?.hasAgreement ?? null}
            onDone={(m) => { void run(async () => m); }} />
        </div>
      </details>
    </div>
  );

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>送る流れ</h2>
        <span className="faint">決定 → 担当者確認 → 相手方確認 → 送付 → 締結。確認と締結は飛ばせます（記録に残ります）</span>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onClose}>閉じる</button>
      </div>
      <div className="panel-bd stack">
        {error && <div className="alert">{error}</div>}
        {note && <div className={`note ${note.includes("⚠") ? "warn" : "ok"}`} style={{ whiteSpace: "pre-line" }}>{note}</div>}
        {sendingWhat && <Sending what={sendingWhat} />}

        {tl && (
          <div className="prail-wrap">
            {/* 左：工程ナビ（本線 5 駅）。駅の中の札が送る流れの段。押すとその段を開く。 */}
            <ProcessRail stations={railStations} foot={tl.current === null ? "全部済んでいます" : "済んだ段は押して戻れます。③ と ⑤ は飛ばせます（記録に残ります）"} />

            {/* 右：開いた段でやること。 */}
            <div className="prail-pane">
              {opened && (
                <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 15 }}>{STATION[opened.station]}　{opened.name}</b>
                  <span className={`tag ${opened.done ? "ok" : opened.skipped ? "warn" : ""}`}>
                    {opened.done ? `済 ${day(opened.at)}` : opened.skipped ? "飛ばした" : tl.current?.key === opened.key ? "いま" : "未"}
                  </span>
                  <span className="faint">{opened.detail}</span>
                </div>
              )}

              {open === "decided" && opened && (
                <div className="faint">{opened.done ? "決定済みです。次は担当者確認（飛ばせます）。" : "決定すると番号が付き、送れるようになります。"}</div>
              )}

              {(open === "owner_check" || open === "party_check") && opened && !opened.done && mailForm()}
              {open === "owner_check" && opened?.done && (
                <div className="stack" style={{ gap: 6 }}>
                  <div className="faint">社内確認は送ってあります。もう一度送るなら下から。</div>
                  <details><summary style={{ cursor: "pointer" }}>もう一度社内確認メールを送る</summary><div style={{ marginTop: 8 }}>{mailForm()}</div></details>
                </div>
              )}
              {open === "party_check" && opened && (
                <div className="stack" style={{ gap: 8, borderTop: opened.done ? undefined : "1px dashed var(--line)", paddingTop: opened.done ? 0 : 8 }}>
                  {!opened.done && <div><b>返事をもらったら記録する</b>　<span className="faint">返信・Slack・電話のどれでも。返信メールが案件に届いていれば、やり取りの記録にも残っています</span></div>}
                  {opened.done && <div className="faint">確認はもらってあります。次は送付です。</div>}
                  {!opened.done && (
                    <>
                      <div className="row" style={{ flexWrap: "wrap" }}>
                        {["メールの返信", "Slack", "電話", "口頭"].map((v) => (
                          <button key={v} className="chip" aria-pressed={via === v} onClick={() => setVia(v)}>{v}</button>
                        ))}
                      </div>
                      <input value={confirmNote} placeholder="ひとこと（誰から・何と言われたか。任意）"
                             onChange={(e) => setConfirmNote(e.target.value)} />
                      <div className="row">
                        <button className="btn" disabled={busy} onClick={() => void confirm()}>確認をもらったと記録する</button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {open === "send" && opened && (
                <div className="stack" style={{ gap: 8 }}>
                  {opened.done && <div className="faint">送付は済んでいます。もう一度送るなら下から。</div>}
                  <div className="row" style={{ flexWrap: "wrap" }}>
                    <span className="faint">送り方：</span>
                    <button className="chip" aria-pressed={sendWay === "mail"} onClick={() => setSendWay("mail")}>メールで送付</button>
                    <button className="chip" aria-pressed={sendWay === "cloudsign"} onClick={() => setSendWay("cloudsign")}>CloudSign で署名依頼</button>
                    {tl.needsExecution && <span className="faint">契約書は CloudSign で署名依頼し、締結まで進めます</span>}
                  </div>
                  {sendWay === "mail" ? mailForm() : cloudSignPane()}
                </div>
              )}

              {open === "notice" && notice && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <b style={{ fontSize: 15 }}>確かめる　担当者・通知先</b>
                    <span className={`tag ${notice.filled ? "ok" : "warn"}`}>{notice.filled ? "入っています" : "空いています"}</span>
                  </div>
                  {notice.filled && <div className="faint">甲の通知先と乙（当社）の担当者は本文に入っています。次へ進んでください。</div>}
                  {!notice.filled && notice.target && (
                    <>
                      <div className="faint">空いている欄に次を入れて、訂正版で出し直します（元の締結日・決定日のまま。この版は退いて「訂正版あり」になります）。</div>
                      {notice.target.fills.length > 0 && (
                        <div className="dl">{notice.target.fills.map((x) => <div key={x.field}><span className="faint">{x.label}</span>　{x.value}</div>)}</div>
                      )}
                      {notice.target.skip && <div className="note warn">{notice.target.skip}</div>}
                      {(notice.target.skip?.includes("担当者") || notice.target.fills.some((x) => x.label.includes("乙")) || !notice.staff) && (
                        <div>
                          <div className="faint">乙（当社）の担当者</div>
                          <OwnerStaffPicker value={noticeStaff} onChange={setNoticeStaff} disabled={busy} emptyLabel="担当者を選ぶ" />
                        </div>
                      )}
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn primary" disabled={busy || !isAdmin || Boolean(notice.target.skip) || !notice.target.fills.length}
                          onClick={() => void run(async () => {
                            const r = await api.post<{ reissued: number; results: Array<{ error?: string | null; newDocumentNo?: string | null }> }>(
                              "/notice-fill", { documentIds: [documentId], ownerStaffId: noticeStaff });
                            const err = r.results.find((x) => x.error)?.error;
                            if (err) throw new Error(err);
                            await loadNotice(noticeStaff);
                            return `担当者・通知先を入れた訂正版 ${r.results[0]?.newDocumentNo ?? ""} を出しました。この版は退きました。一覧から訂正版を開いて送ってください`;
                          }, "訂正版を作っています")}>担当者を入れて訂正版を出す</button>
                        <span className="faint">まとめて直すなら 運用 › 一括修正 › 通知先</span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {open === "executed" && opened && (
                <div className="stack" style={{ gap: 8 }}>
                  {!opened.done && !opened.optional && (
                    <CloudSignManual documentId={documentId} documentNo={documentNo} initial="executed"
                      defaultSigner={signer} hasAgreement={tl.hasAgreement ?? null}
                      onDone={(m) => { void run(async () => m); }} />
                  )}
                  <SkipBox step={opened} busy={busy} onSkip={(r) => void skip("executed", r)} />
                </div>
              )}
            </div>
          </div>
        )}

        {tl && (
          <details open={historyOpen} onToggle={(e) => setHistoryOpen((e.target as HTMLDetailsElement).open)}>
            <summary style={{ cursor: "pointer" }}>この文書の履歴（{tl.events.length} 件）</summary>
            <div className="trace" style={{ marginTop: 6 }}>
              {[...tl.events].reverse().map((e, i) => (
                <div key={i} className="trace-line">
                  <span className="faint" style={{ fontFamily: "var(--mono)", marginRight: 8 }}>{when(e.at)}</span>
                  <b>{ACTION_LABEL[e.action] ?? e.action}</b>
                  <span className="faint" style={{ marginLeft: 8 }}>
                    {e.action === "document.step_skipped"
                      ? `${STEP_LABEL[String(e.detail.step)] ?? String(e.detail.step)}${e.detail.reason ? `：${String(e.detail.reason)}` : ""}`
                      : [e.detail.recipient, e.detail.via, e.detail.note, e.detail.externalId ? `#${String(e.detail.externalId)}` : null]
                        .filter(Boolean).map(String).join("　")}
                    {`（${e.actor}）`}
                  </span>
                </div>
              ))}
              {!tl.events.length && <div className="trace-line faint">まだ記録はありません</div>}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
