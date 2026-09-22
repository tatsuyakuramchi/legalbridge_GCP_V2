import { useState, type CSSProperties, type ReactNode } from "react";
import { readCsv } from "./csv-file.js";

/**
 * CSV の出入口。
 *
 * 出す・入れる・雛形の3つが、これまで同じ見た目のボタンで画面ごとに散って
 * いた（5画面に13か所）。「発注書をまとめて作る（CSV）」は入れる、
 * 「決済済みを CSV に出す」は出す。押すまでどちらか分からなかった。
 *
 * 帯は上から 出す／入れる／雛形 の順で固定する。どの画面でも同じ並びなので、
 * 場所を覚えれば読まなくても押せる。渡さなかった段は出さない（取り込むだけの
 * 画面で、空の「書き出す」段を見せても迷うだけ）。
 */

export interface CsvExport {
  value: string;
  label: string;
  /** 押したときに走る。CSV を落とすのは呼ぶ側の仕事。 */
  run?: () => void | Promise<void>;
  /**
   * いまは押せない理由（「先に案件を選んでください」など）。
   * 段ごと消すと、書き出せる画面なのかどうかが分からなくなる。
   */
  disabled?: string;
  /**
   * ブラウザにそのまま取らせる口。run の代わりに渡す。
   * 全件出力のように、画面で受けるものが何も無いときはこちら。
   */
  href?: string;
}

export function CsvBar({
  title = "CSV", exports: outs, extra, onPick, picked, onClearPick,
  templates, busy, note, uploadLabel = "ファイルを選ぶ", style
}: {
  title?: string;
  /** 書き出せるもの。2つ以上ならプルダウンになる。 */
  exports?: CsvExport[];
  /** 書き出す条件（初版として／現物どおり など）。出す段の右に並ぶ。 */
  extra?: ReactNode;
  /** 取り込む。選んだ中身をそのまま渡す（文字コードはここで吸う）。 */
  onPick?: (text: string, fileName: string) => void;
  picked?: string | null;
  onClearPick?: () => void;
  /** 雛形（空の見本）。一から書くとき用。 */
  templates?: Array<{ label: string; href: string; download?: string }>;
  busy?: boolean;
  note?: ReactNode;
  uploadLabel?: string;
  /** 帯そのものの余白。stack の中なら要らない。 */
  style?: CSSProperties;
}) {
  const [choice, setChoice] = useState(outs?.[0]?.value ?? "");
  const chosen = outs?.find((o) => o.value === choice) ?? outs?.[0];

  return (
    <div className="csvbar" style={style}>
      <div className="csvbar-hd">{title}</div>

      {outs && outs.length > 0 && (
        <div className="csvrow">
          <span className="dir out"><span className="arrow">↓</span>書き出す</span>
          {outs.length > 1 && (
            <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
              {outs.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {outs.length === 1 && <span>{outs[0]!.label}</span>}
          {extra}
          {chosen?.href && !chosen.disabled
            ? <a className="btn btn-sm ghost" href={chosen.href}>書き出す</a>
            : <button className="btn btn-sm ghost" disabled={busy || !chosen?.run || !!chosen?.disabled}
                title={chosen?.disabled} onClick={() => void chosen?.run?.()}>
                {busy ? "書き出しています…" : "書き出す"}
              </button>}
          <span className="faint">{chosen?.disabled ?? "読むだけ。台帳は動きません"}</span>
        </div>
      )}

      {onPick && (
        <div className="csvrow">
          <span className="dir in"><span className="arrow">↑</span>取り込む</span>
          {/*
            input を剥き出しにすると、ブラウザ既定の「ファイルを選択／
            選択されていません」が出る。英語混じりで、選んだかどうかも読めない。
            label で包んでボタンに見せ、ファイル名は自分で出す。
          */}
          <label className="btn btn-sm" style={{ cursor: busy ? "default" : "pointer" }}>
            {uploadLabel}
            <input type="file" accept=".csv,text/csv" disabled={busy}
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void readCsv(file).then((text) => onPick(text, file.name));
              }} />
          </label>
          {picked
            ? <>
                <span className="picked">{picked}</span>
                {onClearPick && (
                  <button className="btn btn-sm" onClick={onClearPick} disabled={busy}>外す</button>
                )}
              </>
            : <span className="faint">選ぶと中身を確かめます。入れるのはそのあと</span>}
        </div>
      )}

      {templates && templates.length > 0 && (
        <div className="csvrow">
          <span className="dir tpl"><span className="arrow">◻</span>雛形（空）</span>
          <span className="tpl-links">
            {templates.map((t, i) => (
              <span key={t.href}>
                {i > 0 && <span className="faint">・</span>}
                <a className="linky" href={t.href} download={t.download}>{t.label}</a>
              </span>
            ))}
          </span>
          <span className="faint">一から書くときの見本。中身は空です</span>
        </div>
      )}

      {note && <div className="csvrow"><span className="faint">{note}</span></div>}
    </div>
  );
}
