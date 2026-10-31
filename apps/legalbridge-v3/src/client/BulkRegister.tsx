import { useState } from "react";
import { CsvImport } from "./CsvImport.js";

/**
 * 一括処理 › まとめて登録・更新する（docs/navigation.md）。
 *
 * 台帳を CSV でまとめて入れる・直す入口は、ここ 1 つ。以前は 運用 › 取込・条件明細・作品・
 * 取引先⇔基本契約 に同じ取込（CsvImport）が別々に置かれていて、どこから入れたのか、
 * どの種類があるのかが分かりにくかった。元の画面にはここへのボタンだけ残す。
 *
 * 何を（対象）→ 新しく入れるか今のを直すか → ①ファイルを用意 ②試す ③反映 の順。
 */

export type ImportMode = "create" | "update";
export interface ImportPreset { kind: string; mode?: ImportMode | null }

interface Target {
  kind: string; mode?: ImportMode;
  title: string; what: string;
}
const GROUPS: Array<{ label: string; targets: Target[] }> = [
  { label: "取引先", targets: [
    { kind: "parties", title: "取引先", what: "新しい取引先を登録／名前・住所・区分を直す" }
  ] },
  { label: "作品", targets: [
    { kind: "works", title: "作品", what: "作品を登録（親作品を書けば派生作品）" },
    { kind: "pub_works", title: "出版作品", what: "作品＋紙・電子の条件＋共著の取り分＋CID を 1 行で" }
  ] },
  { label: "契約", targets: [
    { kind: "agreements", mode: "update", title: "基本契約を直す", what: "書き出した契約の件名・期間・親契約・相手方番号を直して戻す" },
    { kind: "existing_contracts", title: "既存契約", what: "紙で結んだ基本契約＋条件書を、外部番号のまま作品の条件に繋ぐ" }
  ] },
  { label: "条件明細", targets: [
    { kind: "license_conditions", title: "利用許諾条件", what: "作品に付く IN の許諾を登録／料率・期間・備考を直す" },
    { kind: "service_conditions", mode: "update", title: "業務委託などの条件を直す", what: "委託料・製品・実費・手数料の一括修正" }
  ] }
];

export function BulkRegister({ preset }: { preset?: ImportPreset | null }) {
  const [picked, setPicked] = useState<ImportPreset | null>(preset ?? null);
  const target = GROUPS.flatMap((g) => g.targets).find((t) => t.kind === picked?.kind) ?? null;
  return (
    <div className="stack">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        {GROUPS.map((g) => (
          <div key={g.label} className="panel">
            <div className="panel-hd"><h2>{g.label}</h2></div>
            <div className="panel-bd stack" style={{ gap: 6 }}>
              {g.targets.map((t) => (
                <button key={t.kind} className={`btn${picked?.kind === t.kind ? " primary" : ""}`}
                        style={{ textAlign: "left", display: "block", whiteSpace: "normal" }}
                        aria-pressed={picked?.kind === t.kind}
                        onClick={() => setPicked({ kind: t.kind, mode: t.mode ?? null })}>
                  <b>{t.title}</b>
                  {/* 選んだカードは地が濃いので、説明は薄い灰色ではなく地の文字色のまま少しだけ落とす。 */}
                  <span className={picked?.kind === t.kind ? undefined : "faint"}
                        style={{ display: "block", fontWeight: 400, ...(picked?.kind === t.kind ? { opacity: 0.9 } : {}) }}>{t.what}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="note">
        どの対象も同じ 3 段です。<b>① ファイルを用意する</b>（新しく入れるならひな形、今のを直すなら登録済みを書き出したもの）→
        <b>② 試す</b>（反映せずに、登録・更新できる行・変更なし・エラーを行番号つきで出す）→
        <b>③ 反映する</b>（エラーの無い行だけ。誰がいつ何を変えたかは監査記録に残る）。空欄の列は触りません。
      </div>

      {picked && (
        <div className="panel">
          <div className="panel-hd">
            <h2>{target?.title ?? "取り込み"}</h2>
            {target && <span className="faint">{target.what}</span>}
            <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setPicked(null)}>閉じる</button>
          </div>
          <div className="panel-bd">
            <CsvImport key={`${picked.kind}:${picked.mode ?? ""}`} initialKind={picked.kind}
                       initialMode={picked.mode ?? undefined} lockKind />
          </div>
        </div>
      )}
    </div>
  );
}
