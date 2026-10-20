/**
 * 画面の場所を URL（ハッシュ）に写す（第 3 段）。
 *
 *   #/documents/123?step=party_check   文書 123 の送る流れ・相手方確認
 *   #/agreement-map/5?mode=tidy        取引先 5 の整理する
 *   #/ops/fixes                        運用 › 一括修正
 *   #/conditions/88                    条件明細 88
 *
 * 形は `#/<画面>[/<id>][?k=v&…]`。ブラウザの戻る・進むで画面が戻り、リンクを貼れば同じ場所が開く。
 * 作業テーブルの途中の状態は URL に入れない（このブラウザに残してあるので、開けば続きから）。
 *
 * 書くのは App（画面と選んだ行が変わったとき）。読むのは App（初回と戻る・進む）。
 * 画面の中の細かい段（送る流れの段）は、その部品が `replaceRouteParams` で足す。
 */

export interface Route {
  view: string;
  id?: number | null;
  params: Record<string, string>;
}

export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const [pathPart, query = ""] = raw.split("?", 2) as [string, string | undefined];
  const [view, idPart] = pathPart.split("/", 2) as [string, string | undefined];
  if (!view) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  const id = idPart && /^\d+$/.test(idPart) ? Number(idPart) : idPart ? null : undefined;
  // `#/ops/fixes` のように id の場所に名前が来る画面は、名前を params.sub に入れる。
  if (idPart && id === null) params.sub = idPart;
  return { view, id: id ?? undefined, params };
}

export function formatHash(route: Route): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(route.params)) if (v !== "" && k !== "sub") q.set(k, v);
  const sub = route.params.sub;
  const path = `#/${route.view}${route.id ? `/${route.id}` : sub ? `/${sub}` : ""}`;
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** ハッシュの道の部分（? より前）。同じ場所かどうかはここで見る。 */
export const routePath = (hash: string): string => hash.replace(/^#\/?/, "").split("?", 1)[0] ?? "";

/** いまの場所のまま、問い合わせの部分だけ差し替える（履歴は増やさない）。空の値は消す。 */
export function replaceRouteParams(patch: Record<string, string | null | undefined>): void {
  if (typeof window === "undefined") return;
  const current = parseHash(window.location.hash);
  if (!current) return;
  const params = { ...current.params };
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === "") delete params[k]; else params[k] = v; }
  const next = formatHash({ ...current, params });
  if (next !== window.location.hash) window.history.replaceState(window.history.state, "", next);
}

/** 場所を動かす（履歴に積む）。道が同じなら問い合わせだけ置き換える。 */
export function pushRoute(route: Route): void {
  if (typeof window === "undefined") return;
  const next = formatHash(route);
  const cur = window.location.hash;
  if (next === cur) return;
  if (routePath(next) === routePath(cur)) {
    // 同じ画面・同じ行。段などの細かい違いは履歴に積まない。
    window.history.replaceState(window.history.state, "", next);
  } else {
    window.history.pushState(window.history.state, "", next);
  }
}
