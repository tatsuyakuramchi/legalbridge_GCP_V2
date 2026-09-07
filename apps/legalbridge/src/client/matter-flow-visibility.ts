// 案件タイプが変更された後も、過去に紐づけた文書や工程に引きずられず
// 現在の案件タイプを画面構造の唯一の判定基準にする。
export function shouldShowServiceOutsourcingFlow(matterKind: string | null | undefined): boolean {
  return matterKind === "service";
}
