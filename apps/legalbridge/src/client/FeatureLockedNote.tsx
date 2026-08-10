import type { ReactNode } from "react";

// 未有効化（権限/機能フラグ未付与）を end-user 向けに**統一表現**で伝える注記。
// 内部語（GRANT 番号・capability 名）は出さない。文言のばらつきを1箇所に集約する。
export function FeatureLockedNote({ children }: { children?: ReactNode }) {
  return (
    <small className="hint" role="note">
      {children ?? "この操作は現在ご利用いただけません。管理者が設定で有効化できます。"}
    </small>
  );
}
