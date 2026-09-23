import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import { SearchSelect, type SearchOption } from "./SearchSelect.js";
import { RightsScopePicker } from "./RightsScopePicker.js";

/**
 * 新規登録のフォーム。
 *
 * 5画面で同じ形にするために1つにまとめてある。検証はサーバ側が持っていて、
 * ここは「サーバが返した理由をそのまま見せる」だけにする。二重に書くと
 * 片方だけ直したときに食い違うため。
 */

export type FieldType = "text" | "number" | "money" | "date" | "select" | "search"
  | "textarea" | "checkbox" | "regions" | "languages";

export interface Field {
  name: string;
  /** 見出し。計算方式で意味が変わる欄（定額／1回あたり）は関数で渡す。 */
  label: string | ((values: Record<string, string>) => string);
  type?: FieldType;
  required?: boolean;
  placeholder?: string;
  /** 補足。他の項目に応じて変えたいときは関数で渡す（通貨で単位が変わる欄など）。 */
  hint?: string | ((values: Record<string, string>) => string);
  options?: Array<{ value: string; label: string; hint?: string | null }>;
  /**
   * type "search" のとき、サーバに聞く検索。無ければ options をここで絞る。
   * 一覧が長いもの（取引先・担当者・作品）はプルダウンではなくこちらを使う。
   */
  search?: (q: string) => Promise<SearchOption[]>;
  /** 他の項目の値によって出し入れする。 */
  visibleWhen?: (values: Record<string, string>) => boolean;
  /** type "search" で、初期値の表示名（案件から相手先を引き継いだときなど。無いと「#2」と出る）。 */
  valueLabel?: string | null;
  /** 文字の欄の候補（datalist）。選べるが打てる。支払条件・契約形式の定型文に使う。 */
  suggestions?: string[];
}

export interface CreateFormProps {
  title: string;
  fields: Field[];
  submitLabel?: string;
  /** 初期値。select の既定値もここで決める。 */
  initial?: Record<string, string>;
  /** 入力値を API に渡す形へ。空文字は落とすなど、画面の都合をここで吸収する。 */
  toPayload: (values: Record<string, string>) => Record<string, unknown>;
  path: string;
  onDone: (result: any) => void;
  onCancel: () => void;
  /** 409 のときに出す「それでも作る」の再送。渡さなければ再送しない。 */
  retryOnConflict?: { label: string; extra: Record<string, unknown> };
  children?: ReactNode;
  /**
   * 値が変わるたびに呼ぶ。他の項目を引いて埋めたいとき（相手先を選んだら
   * その相手の契約を当てる、など）に使う。set で他の項目を書き換えられる。
   */
  onValues?: (values: Record<string, string>, set: (name: string, value: string) => void) => void;
}

export function CreateForm(props: CreateFormProps) {
  const [values, setValues] = useState<Record<string, string>>(props.initial ?? {});
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  useEffect(() => { props.onValues?.(values, set); }, [values]);

  async function submit(extra: Record<string, unknown> = {}) {
    setBusy(true); setError(null);
    try {
      const result = await api.post<any>(props.path, { ...props.toPayload(values), ...extra });
      props.onDone(result);
    } catch (e) {
      const err = e as ApiError;
      setError({ message: err.message, conflict: err.status === 409 });
    } finally { setBusy(false); }
  }

  const visible = props.fields.filter((f) => !f.visibleWhen || f.visibleWhen(values));
  const missing = visible.filter((f) => f.required && !String(values[f.name] ?? "").trim());

  return (
    <div className="panel create-form">
      <div className="panel-hd">
        <h2>{props.title}</h2>
        <span className="faint">必須は {visible.filter((f) => f.required).length} 項目</span>
      </div>
      <div className="panel-bd">
        <div className="form-grid">
          {visible.map((f) => (
            <label key={f.name} className={f.type === "textarea" ? "field wide" : "field"}>
              <span>
                {typeof f.label === "function" ? f.label(values) : f.label}
                {f.required && <em className="req"> 必須</em>}
              </span>
              {f.type === "select" ? (
                <select value={values[f.name] ?? ""} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">—</option>
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : f.type === "search" ? (
                <SearchSelect value={values[f.name] ?? ""} options={f.search ? undefined : (f.options ?? [])}
                  search={f.search} emptyLabel={f.required ? undefined : "—"}
                  valueLabel={values[f.name] && values[f.name] === (props.initial?.[f.name] ?? "") ? f.valueLabel : null}
                  placeholder={f.placeholder ?? "名前の一部で探す"}
                  onChange={(v) => set(f.name, v)} />
              ) : f.type === "regions" || f.type === "languages" ? (
                /* 許諾の範囲。ISO のコードから選ぶ（自由記載だと表記が割れる）。 */
                <RightsScopePicker kind={f.type === "regions" ? "region" : "language"}
                  value={values[f.name] ?? ""} onChange={(v) => set(f.name, v)} />
              ) : f.type === "textarea" ? (
                <textarea rows={3} value={values[f.name] ?? ""} placeholder={f.placeholder}
                  onChange={(e) => set(f.name, e.target.value)} />
              ) : f.type === "checkbox" ? (
                <input type="checkbox" checked={values[f.name] === "1"}
                  onChange={(e) => set(f.name, e.target.checked ? "1" : "")} />
              ) : (
                <>
                  <input
                    type={f.type === "date" ? "date" : f.type === "number" || f.type === "money" ? "number" : "text"}
                    inputMode={f.type === "money" || f.type === "number" ? "numeric" : undefined}
                    list={f.suggestions?.length ? `${f.name}-suggestions` : undefined}
                    value={values[f.name] ?? ""} placeholder={f.placeholder}
                    onChange={(e) => set(f.name, e.target.value)} />
                  {f.suggestions?.length ? (
                    <datalist id={`${f.name}-suggestions`}>
                      {f.suggestions.map((s) => <option key={s} value={s} />)}
                    </datalist>
                  ) : null}
                </>
              )}
              {(typeof f.hint === "function" ? f.hint(values) : f.hint) && (
                <small className="faint">
                  {typeof f.hint === "function" ? f.hint(values) : f.hint}
                </small>
              )}
            </label>
          ))}
        </div>

        {props.children}

        {error && (
          <div className="alert">
            {error.message}
            {error.conflict && props.retryOnConflict && (
              <button className="btn btn-sm" disabled={busy}
                onClick={() => submit(props.retryOnConflict!.extra)}>
                {props.retryOnConflict.label}
              </button>
            )}
          </div>
        )}

        <div className="row">
          <button className="btn primary" disabled={busy || missing.length > 0}
            onClick={() => submit()}>
            {busy ? "登録中…" : props.submitLabel ?? "登録する"}
          </button>
          <button className="btn" onClick={props.onCancel} disabled={busy}>やめる</button>
          {missing.length > 0 && (
            <span className="faint">
              {missing.map((f) => (typeof f.label === "function" ? f.label(values) : f.label)).join("・")}
              {" が未入力です"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 空文字を落として API へ渡す。「未入力」と「空にする」を取り違えないため。 */
export const text = (v: string | undefined) => {
  const s = String(v ?? "").trim();
  return s ? s : undefined;
};
export const int = (v: string | undefined) => {
  const s = String(v ?? "").trim();
  return s ? Number(s) : undefined;
};
export const flag = (v: string | undefined) => (v === "1" ? true : undefined);
