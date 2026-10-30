import { useState } from "react";
import { ConditionCreateForm } from "./ConditionCreateForm.js";
import { LicenseSetForm } from "./LicenseSetForm.js";
import { PubConditionSetForm } from "./PubConditionSetForm.js";
import { OutConditionForm } from "./OutConditionForm.js";
import { ServiceLinesForm } from "./ServiceLinesForm.js";
import type { WorkOption } from "./WorkChooser.js";

/**
 * 条件明細を登録する 1 つの入口。
 *
 * 以前は 許諾セット（ゲーム）・出版セット・許諾先（OUT）・業務委託の明細・1 本だけ の
 * 4〜5 個のボタンが、条件明細・契約・作品・案件・取引の画面に別々に並んでいた。
 * ここで「取引の種類」を選んでから、同じフォームに進む。開くのは 条件明細・契約・作品・
 * 案件（繋ぐ／取引先ごと）の画面と、作業テーブルの「条件を足す」。どこから開いても同じ形。
 *
 * 登録したら、その条件で作る文書のひな形を添えて返す（作業テーブルの①がそれを既定にする）。
 */
export type ConditionEntryKind = "game_in" | "pub_in" | "out" | "service" | "one";

export const ENTRY_KINDS: Array<{ value: ConditionEntryKind; label: string; hint: string; templateKey: string | null }> = [
  { value: "game_in", label: "ゲーム IN（権利を取得）", hint: "作品 1 点の自社製造・再許諾・他社販売を 1 回で。個別利用許諾条件書に畳む", templateKey: "individual_license_terms_v4" },
  { value: "pub_in", label: "出版 IN（紙・電子）", hint: "作品 1 点の紙・電子（と翻訳の再許諾）を 1 回で。出版条件書に畳む", templateKey: "pub_master_individual" },
  { value: "out", label: "OUT（許諾先）", hint: "許諾先 1 社の利用形態 1 つ。IN 条件の範囲内で", templateKey: "pub_license_terms_v3" },
  { value: "service", label: "業務委託（発注）", hint: "委託料に実費・手数料を組にして 1 回で。発注書に載せる", templateKey: "purchase_order" },
  { value: "one", label: "1 本だけ（その他）", hint: "上のどれにも当たらないとき。種類と計算方式を自分で選ぶ", templateKey: null }
];

export function ConditionEntryForm(
  { initialKind, preset, onDone, onCancel }: {
    initialKind?: ConditionEntryKind | null;
    /** 分かっている値（相手先・作品・契約・案件）。開いた画面が知っていることは人に打たせない。 */
    preset?: {
      counterpartyId?: number | null; counterpartyName?: string | null;
      workId?: number | null; workTitle?: string | null;
      /** 契約の画面から：この契約に載せる。 */
      agreementId?: number | null; agreementLabel?: string | null;
      /** 案件の画面から：作った条件を案件に繋ぐ（セット系のフォームはサーバが繋ぐ）。 */
      matterId?: number | null;
      /** 「1 本だけ」の既定（方向・種類・通貨）。 */
      direction?: string | null; kind?: string | null; currency?: string | null;
      /** 業務委託の明細の行で選べる作品（案件の作品など）。 */
      workOptions?: WorkOption[];
    };
    onDone: (created: { conditionIds: number[]; templateKey: string | null }) => void;
    onCancel: () => void;
  }
) {
  const [kind, setKind] = useState<ConditionEntryKind | null>(initialKind ?? null);
  const common = {
    counterpartyId: preset?.counterpartyId ? String(preset.counterpartyId) : undefined,
    workId: preset?.workId ? String(preset.workId) : undefined,
    agreementId: preset?.agreementId ? String(preset.agreementId) : undefined,
    matterId: preset?.matterId ? String(preset.matterId) : undefined
  };
  const labels = { counterpartyId: preset?.counterpartyName ?? null, workId: preset?.workTitle ?? null, agreementId: preset?.agreementLabel ?? null };
  const done = (ids: number[], key: string | null) => onDone({ conditionIds: ids.filter((x) => Number.isFinite(x)), templateKey: key });

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="panel">
        <div className="panel-hd"><h2>条件明細を登録する</h2><span className="faint">まず取引の種類</span>
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onCancel}>やめる</button></div>
        <div className="panel-bd">
          <div className="chips" role="radiogroup" aria-label="取引の種類">
            {ENTRY_KINDS.map((k) => (
              <button key={k.value} type="button" className="chip" role="radio" aria-checked={kind === k.value} aria-pressed={kind === k.value}
                      title={k.hint} onClick={() => setKind(k.value)}>{k.label}</button>
            ))}
          </div>
          {kind && <div className="faint" style={{ marginTop: 6 }}>{ENTRY_KINDS.find((k) => k.value === kind)?.hint}</div>}
        </div>
      </div>
      {kind === "game_in" && (
        <LicenseSetForm preset={common} presetLabels={labels}
                        onDone={(r) => done(r.conditions.map((c) => c.id), "individual_license_terms_v4")} onCancel={onCancel} />
      )}
      {kind === "pub_in" && (
        <PubConditionSetForm preset={common}
                             onDone={(r) => done([r.print, r.digital, r.translationPrint, r.translationDigital].flatMap((c) => (c ? [c.id] : [])), "pub_master_individual")}
                             onCancel={onCancel} />
      )}
      {kind === "out" && (
        <OutConditionForm preset={{ ...common, ...(preset?.currency ? { currency: preset.currency } : {}) }} presetLabels={labels}
                          onDone={(r) => done([r.id], "pub_license_terms_v3")} onCancel={onCancel} />
      )}
      {kind === "service" && (
        <ServiceLinesForm preset={common} counterpartyName={preset?.counterpartyName ?? null} workTitle={preset?.workTitle ?? null}
                          workOptions={preset?.workOptions}
                          onDone={(r) => done(r.conditions.map((c) => c.id), "purchase_order")} onCancel={onCancel} />
      )}
      {kind === "one" && (
        <ConditionCreateForm presetLabels={labels}
                             preset={{ ...common, ...(preset?.direction ? { direction: preset.direction } : {}),
                                       ...(preset?.kind ? { kind: preset.kind } : {}), ...(preset?.currency ? { currency: preset.currency } : {}) }}
                             onDone={(r) => done(r.conditionIds ?? [r.id], r.templateKey ?? null)} onCancel={onCancel} />
      )}
    </div>
  );
}
