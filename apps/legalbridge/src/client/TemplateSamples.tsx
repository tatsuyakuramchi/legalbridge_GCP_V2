import { useEffect, useState } from "react";
import { EmptyState } from "./EmptyState";

// ひな形プレビュー（V1 search-api /templates/preview の V2 版）。
// テンプレート一覧からサンプル値入りの完成イメージを閲覧する（読み取り専用）。
// IGLA のように variants を持つテンプレは、取引モデル別のタブで複数のサンプルを出す。

interface SampleTemplate {
  templateKey: string;
  label: string;
  category: string;
  variants: Array<{ id: string; label: string }>;
}

export function TemplateSamples() {
  const [templates, setTemplates] = useState<SampleTemplate[] | null>(null);
  const [selected, setSelected] = useState<{ key: string; variant: string } | null>(null);
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/v2/template-samples");
      if (!res.ok || cancelled) return;
      const body = await res.json();
      if (!cancelled) setTemplates(Array.isArray(body.templates) ? body.templates : []);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const res = await fetch(
        `/api/v2/template-samples/${encodeURIComponent(selected.key)}/html?variant=${encodeURIComponent(selected.variant)}`);
      const text = res.ok ? await res.text() : "<p>プレビューの取得に失敗しました。</p>";
      if (!cancelled) { setHtml(text); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  if (templates === null) {
    return <section className="page"><h1>ひな形</h1><p>テンプレート一覧を読み込んでいます…</p></section>;
  }

  const categories = [...new Set(templates.map((t) => t.category || "その他"))];
  const current = templates.find((t) => t.templateKey === selected?.key);

  return <section className="page template-samples">
    <header className="page-header">
      <h1>ひな形</h1>
      <p className="muted-note">
        各テンプレートの完成イメージをサンプル値入りで表示します（実データは含まれません）。
        作成は「文書」から行ってください。
      </p>
    </header>

    <div className="sample-layout">
      <nav className="sample-list">
        {categories.map((category) => <div key={category}>
          <h2>{category}</h2>
          {templates.filter((t) => (t.category || "その他") === category).map((t) =>
            <div key={t.templateKey} className="sample-item">
              <button type="button"
                className={selected?.key === t.templateKey ? "active" : ""}
                onClick={() => setSelected({ key: t.templateKey, variant: t.variants[0].id })}>
                {t.label}
              </button>
              {t.variants.length > 1 && selected?.key === t.templateKey &&
                <div className="sample-variants">
                  {t.variants.map((v) =>
                    <button key={v.id} type="button"
                      className={`variant-chip ${selected?.variant === v.id ? "active" : ""}`}
                      onClick={() => setSelected({ key: t.templateKey, variant: v.id })}>
                      {v.label}
                    </button>)}
                </div>}
            </div>)}
        </div>)}
        {!templates.length && <EmptyState title="テンプレートがありません"
          description="document_templates にテンプレートが登録されると表示されます。" />}
      </nav>

      <div className="sample-viewer">
        {!selected && <EmptyState title="テンプレートを選択してください"
          description="左の一覧から選ぶと、サンプル値入りの完成イメージを表示します。" />}
        {selected && <>
          <div className="sample-viewer-head">
            <strong>{current?.label}</strong>
            {(current?.variants.length ?? 0) > 1 &&
              <span className="muted-note">
                {current?.variants.find((v) => v.id === selected.variant)?.label}
              </span>}
            <a className="link-button" target="_blank" rel="noreferrer"
              href={`/api/v2/template-samples/${encodeURIComponent(selected.key)}/html?variant=${encodeURIComponent(selected.variant)}`}>
              別タブで開く
            </a>
          </div>
          {loading
            ? <p className="muted-note">プレビューを描画しています…</p>
            : <iframe title="ひな形プレビュー" className="sample-frame" srcDoc={html} />}
        </>}
      </div>
    </div>
  </section>;
}
