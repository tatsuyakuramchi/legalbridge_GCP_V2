import { useState } from "react";
import type { Row } from "./LineItems.js";

/**
 * 個別利用許諾条件書の2つの表。
 *
 *   取引形態（v3_conds）… 固定3種。どの形態で許諾するかと、その条件（地域・
 *                          言語・数量・AG・MG・通貨）。id は 1/2/3 固定で、
 *                          構成要素の料率マップの鍵になるので変えない。
 *   構成要素（v3_lcs）  … 作品を組み立てている素材と、その権利元。加算型の
 *                          形態は、ここに並ぶ料率の合計が実効料率になる。
 *
 * 種は条件明細と作品の取得条件から入れてある（V1・V2 は全部手打ちだった）。
 * ここで直したものが本文にそのまま出る。
 */

const REGION_PRESETS = ["全世界", "日本", "全世界（日本を除く）", "北米", "欧州", "アジア", "中国", "韓国", "台湾"];
const LANGUAGE_PRESETS = ["全言語", "日本語", "英語", "日本語・英語", "中国語（簡体字）", "中国語（繁体字）", "韓国語"];

const CALC_LABEL: Record<string, string> = {
  BASE_QTY_RATE: "基準価格×個数×料率", BASE_RATE: "実効料率", FIXED: "固定額",
  SUBSCRIPTION: "サブスク", SUPPLY_QTY: "供給価格×個数×料率"
};

const text = (v: unknown) => (v == null ? "" : String(v));
const rates = (row: Row): Record<string, unknown> =>
  row.rates && typeof row.rates === "object" ? row.rates as Record<string, unknown> : {};

export function LicenseTermsMatrix(
  { deals, materials, seedDeals, seedMaterials, onChange }: {
    /** いま画面が持っている行。null なら種のまま（まだ直していない）。 */
    deals: Row[] | null;
    materials: Row[] | null;
    seedDeals: Row[];
    seedMaterials: Row[];
    onChange: (name: "v3_conds" | "v3_lcs", rows: Row[] | null) => void;
  }
) {
  const [open, setOpen] = useState(true);
  const dealRows = deals ?? seedDeals;
  const materialRows = materials ?? seedMaterials;
  const addons = dealRows.filter((d) => Boolean(d.addon));

  const setDeal = (index: number, patch: Row) =>
    onChange("v3_conds", dealRows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const setMaterial = (index: number, patch: Row) =>
    onChange("v3_lcs", materialRows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const setRate = (index: number, dealId: unknown, value: string) =>
    setMaterial(index, { rates: { ...rates(materialRows[index]), [String(dealId)]: value } });

  // 料率が入っているのに素材コードが無い行は、台帳と結線されない。
  // 黙って弱いデータを入れないよう、決定する前に見せる。
  const warnings = materialRows.flatMap((row, i) => {
    const has = Object.values(rates(row)).some((v) => String(v ?? "").trim() !== "");
    return has && !text(row.material_code).trim()
      ? [`構成要素${i + 1}（${text(row.name) || "名称未設定"}）に素材コードがありません`]
      : [];
  });

  const changed = deals !== null || materials !== null;

  return (
    <div className="panel">
      <div className="panel-hd">
        <h2>取引形態と構成要素</h2>
        <span className="faint">
          条件明細と作品の取得条件から入れてあります{changed ? "（直しました）" : ""}
        </span>
        <span className="row" style={{ marginLeft: "auto" }}>
          {changed && (
            <button className="btn btn-sm"
                    onClick={() => { onChange("v3_conds", null); onChange("v3_lcs", null); }}>
              種に戻す
            </button>
          )}
          <button className="btn btn-sm" onClick={() => setOpen(!open)}>
            {open ? "畳む" : "開く"}
          </button>
        </span>
      </div>

      {open && (
        <div className="panel-bd stack">
          {warnings.map((w) => <div key={w} className="note warn">{w}</div>)}

          <datalist id="v3-region-presets">
            {REGION_PRESETS.map((v) => <option key={v} value={v} />)}
          </datalist>
          <datalist id="v3-lang-presets">
            {LANGUAGE_PRESETS.map((v) => <option key={v} value={v} />)}
          </datalist>

          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <b>取引形態（固定3種）</b>
              <span className="faint">
                加算型は構成要素の料率の合計が実効料率になります。非加算型は実効料率をここに入れます
              </span>
            </div>
            {dealRows.map((deal, index) => (
              <div key={String(deal.id ?? index)} className="trace">
                <div className="row">
                  <b>{index + 1}. {text(deal.name)}</b>
                  <span className="tag">{deal.addon ? "加算型" : "非加算型"}</span>
                  <span className="faint">
                    {CALC_LABEL[text(deal.calc_type)] ?? "—"}／基準: {text(deal.basePrice) || "—"}
                  </span>
                  {deal.conditionNo ? (
                    <span className="code faint" style={{ marginLeft: "auto" }}>
                      {text(deal.conditionNo)} から
                    </span>
                  ) : null}
                </div>
                <div className="row">
                  {!deal.addon && (
                    <label className="field">
                      <span>実効料率（%）</span>
                      <input type="number" value={text(deal.fixedRate)}
                             onChange={(e) => setDeal(index, { fixedRate: e.target.value })} />
                    </label>
                  )}
                  <label className="field">
                    <span>今回地域</span>
                    <input list="v3-region-presets" value={text(deal.reg)}
                           onChange={(e) => setDeal(index, { reg: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>今回言語</span>
                    <input list="v3-lang-presets" value={text(deal.lang)}
                           onChange={(e) => setDeal(index, { lang: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>数量</span>
                    <input value={text(deal.qty)}
                           onChange={(e) => setDeal(index, { qty: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>AG</span>
                    <input type="number" value={text(deal.ag)}
                           onChange={(e) => setDeal(index, { ag: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>MG</span>
                    <input type="number" value={text(deal.mg)}
                           onChange={(e) => setDeal(index, { mg: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>通貨</span>
                    <input value={text(deal.cur)}
                           onChange={(e) => setDeal(index, { cur: e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <div className="row">
              <b>構成要素</b>
              <span className="faint">
                作品の取得条件から並べています。料率の列は加算型の形態のぶんだけ出ます
              </span>
              <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                      onClick={() => onChange("v3_lcs", [...materialRows, {
                        material_code: "", name: "", holder: "",
                        region: "全世界", language: "全言語", rates: {}
                      }])}>
                行を足す
              </button>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>素材コード</th><th>名称</th><th>権利元</th><th>地域</th><th>言語</th>
                    {addons.map((d) => (
                      <th key={String(d.id)} className="num">{text(d.name)}<br />料率(%)</th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {materialRows.map((row, index) => (
                    <tr key={index}>
                      <td>
                        <input className="code" value={text(row.material_code)}
                               onChange={(e) => setMaterial(index, { material_code: e.target.value })} />
                      </td>
                      <td>
                        <input value={text(row.name)}
                               onChange={(e) => setMaterial(index, { name: e.target.value })} />
                      </td>
                      <td>
                        <input value={text(row.holder)}
                               onChange={(e) => setMaterial(index, { holder: e.target.value })} />
                      </td>
                      <td>
                        <input list="v3-region-presets" value={text(row.region)}
                               onChange={(e) => setMaterial(index, { region: e.target.value })} />
                      </td>
                      <td>
                        <input list="v3-lang-presets" value={text(row.language)}
                               onChange={(e) => setMaterial(index, { language: e.target.value })} />
                      </td>
                      {addons.map((d) => (
                        <td key={String(d.id)} className="num">
                          <input type="number" style={{ width: 70 }}
                                 value={text(rates(row)[String(d.id)])}
                                 onChange={(e) => setRate(index, d.id, e.target.value)} />
                        </td>
                      ))}
                      <td>
                        <button className="btn btn-sm"
                                onClick={() => onChange("v3_lcs", materialRows.filter((_, i) => i !== index))}>
                          外す
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!materialRows.length && (
                    <tr>
                      <td colSpan={6 + addons.length} className="faint">
                        構成要素がありません。作品に取得条件を登録すると、ここに並びます
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
