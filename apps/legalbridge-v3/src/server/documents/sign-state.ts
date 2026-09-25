/**
 * 文書ごとの CloudSign の状態。
 *
 * 文書の「送信済み」は監査記録（cloudsign.send）から引いていて、締結・辞退は
 * 合意の状態に書いていた。発注書や検収書は合意を持たないので、CloudSign で
 * 締結しても文書からはそれが読めず、束の画面では「決定済み」で止まって見えた。
 *
 * ここでは文書に対する記録（送った／締結した／辞退・取下げ／未送信に戻した）
 * だけを見て、いちばん新しいものを状態にする。CloudSign から届いたものも、
 * 人が手で記録したものも同じ列に並ぶので、CloudSign の連携が止まっていたり
 * 古かったりしても、手で記録すればそれが現状になる。
 *
 * 依存を持たない（画面からも読む）。
 */
export type SignStatus = "unsent" | "drafted" | "sent" | "executed" | "terminated";

export interface SignState {
  status: SignStatus;
  /** その状態になった日（東京）。未送信は null。 */
  at: string | null;
  /** cloudsign＝連携で届いた・送った。manual＝人が手で記録した。 */
  source: "cloudsign" | "manual" | null;
}

export const SIGN_STATUSES: SignStatus[] = ["unsent", "drafted", "sent", "executed", "terminated"];

/** drafted は CloudSign に下書きがあるが相手にはまだ送っていない。送信は CloudSign の画面から。 */
export const SIGN_STATUS_LABEL: Record<SignStatus, string> = {
  unsent: "未送信", drafted: "下書き", sent: "送信済", executed: "締結済", terminated: "取下げ"
};

export const UNSENT: SignState = { status: "unsent", at: null, source: null };

/**
 * 文書 1 枚の状態を jsonb で返す副問い合わせ。`docId` は文書 id の式。
 * 記録が無ければ NULL（＝未送信）。
 */
export function signStateSql(docId: string): string {
  return `(SELECT jsonb_build_object('status', s.status, 'at', s.on_day, 'source', s.source)
     FROM (SELECT CASE WHEN a.action = 'cloudsign.send' THEN 'sent'
                       WHEN a.action = 'cloudsign.draft' THEN 'drafted'
                       ELSE a.detail ->> 'status' END AS status,
                  to_char(a.occurred_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS on_day,
                  CASE WHEN COALESCE(a.detail ->> 'manual', 'false') = 'true' THEN 'manual' ELSE 'cloudsign' END AS source
             FROM audit_events a
            WHERE a.target_type = 'document' AND a.target_id = ${docId}
              AND (a.action IN ('cloudsign.send', 'cloudsign.draft')
                   OR (a.action = 'cloudsign.applied'
                       AND a.detail ->> 'status' IN ('sent', 'drafted', 'executed', 'terminated', 'unsent')))
            ORDER BY a.occurred_at DESC, a.id DESC
            LIMIT 1) s)`;
}

function isStatus(v: unknown): v is SignStatus {
  return typeof v === "string" && (SIGN_STATUSES as string[]).includes(v);
}

/** 副問い合わせの結果（オブジェクトか JSON 文字列か NULL）を読む。 */
export function signStateOf(value: unknown): SignState {
  if (value === null || value === undefined || value === "") return UNSENT;
  let v: unknown = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return UNSENT; }
  }
  if (!v || typeof v !== "object") return UNSENT;
  const o = v as Record<string, unknown>;
  if (!isStatus(o.status)) return UNSENT;
  if (o.status === "unsent") return UNSENT;
  return {
    status: o.status,
    at: typeof o.at === "string" && o.at ? o.at.slice(0, 10) : null,
    source: o.source === "manual" ? "manual" : o.source === "cloudsign" ? "cloudsign" : null
  };
}
