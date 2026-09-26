/**
 * 納期アラートの設定（settings の delivery_alert）。
 *
 * 画面（OpsWorkspace の設定タブ）とジョブ（jobs/delivery-alert.ts）の両方がここを読む。
 * 既定値・差込項目・形の確かめ方を二重に書くと必ずずれるので、1か所に置く。
 * ブラウザでも読むので、サーバ専用のものは import しない。
 */

export const DELIVERY_ALERT_KEY = "delivery_alert";

export interface DeliveryAlertSettings {
  /** 止めるときは false。止めている間も判定だけはプレビューで見られる。 */
  enabled: boolean;
  /** 納期の何日前に知らせるか（その日ちょうどに1回）。 */
  daysBefore: number[];
  /** 超過を知らせるか。 */
  overdue: boolean;
  /** 超過は平日だけ知らせる（V1 と同じ）。 */
  overdueWeekdaysOnly: boolean;
  /** 超過して何日まで知らせ続けるか。0 なら納めるまでずっと。 */
  overdueUntilDays: number;
  /** 案件の依頼者に DM する。 */
  notifyRequester: boolean;
  /** 案件の担当（法務）に DM する。 */
  notifyOwner: boolean;
  /** いつも送るチャンネル（ID）。 */
  channels: Array<{ id: string; label: string }>;
  /** 依頼者の部署ごとの送り先チャンネル。部署名は職員の「部署」と同じ書き方。 */
  departmentChannels: Array<{ department: string; id: string }>;
  /** 文面。{差込} は下の DELIVERY_ALERT_FIELDS。 */
  templates: { before: string; overdue: string };
}

/** 文面に差し込める項目。画面の説明にもそのまま出す。 */
export const DELIVERY_ALERT_FIELDS: Array<{ name: string; label: string }> = [
  { name: "残り日数", label: "納期まであと何日か（超過なら 0）" },
  { name: "超過日数", label: "納期を何日過ぎたか（前なら 0）" },
  { name: "納期", label: "納期（2026年10月3日 の形）" },
  { name: "案件番号", label: "MTR-2026-00012 など" },
  { name: "件名", label: "案件の件名" },
  { name: "相手先", label: "取引先の名前" },
  { name: "品目", label: "条件の名前（分納なら回の名前も）" },
  { name: "発注書番号", label: "発行済みの発注書の番号（無ければ空）" },
  { name: "依頼者", label: "依頼者への @メンション（チャンネル向け）" }
];

export const DEFAULT_DELIVERY_ALERT: DeliveryAlertSettings = {
  enabled: true,
  daysBefore: [7, 3, 1],
  overdue: true,
  overdueWeekdaysOnly: true,
  overdueUntilDays: 30,
  notifyRequester: true,
  notifyOwner: false,
  channels: [],
  departmentChannels: [],
  templates: {
    before: "⏰ *納期まであと {残り日数} 日です*（{納期}）\n"
      + "*案件:* {案件番号} {件名}\n*相手先:* {相手先}\n*品目:* {品目}\n*発注書:* {発注書番号}\n"
      + "納品を受けたら、Slack の /法務依頼 で案件番号を書いて知らせてください。",
    overdue: "🔴 *納期を {超過日数} 日過ぎています*（{納期}）— 延長か、納品済みなら報告をお願いします\n"
      + "*案件:* {案件番号} {件名}\n*相手先:* {相手先}\n*品目:* {品目}\n*発注書:* {発注書番号}"
  }
};

const SLACK_CHANNEL = /^[CGDU][A-Z0-9]{6,}$/;

/**
 * 保存する値を確かめて整える。直せない誤りは理由の一覧を返す（保存しない）。
 * 画面の保存ボタンとサーバの PUT の両方で使う。
 */
export function parseDeliveryAlertSettings(
  input: unknown
): { value: DeliveryAlertSettings; errors: string[] } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const d = DEFAULT_DELIVERY_ALERT;
  const errors: string[] = [];
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

  const days = Array.isArray(src.daysBefore) ? src.daysBefore : d.daysBefore;
  const daysBefore = [...new Set(days.map((n: unknown) => Number(n)))]
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => b - a);
  if (daysBefore.some((n) => n < 1 || n > 90)) errors.push("何日前は 1〜90 の整数で入れてください");

  const until = src.overdueUntilDays === undefined ? d.overdueUntilDays : Number(src.overdueUntilDays);
  if (!Number.isInteger(until) || until < 0 || until > 365) errors.push("超過を知らせる日数は 0〜365 で入れてください");

  const channels = (Array.isArray(src.channels) ? src.channels : [])
    .map((c: any) => ({ id: String(c?.id ?? "").trim(), label: String(c?.label ?? "").trim() }))
    .filter((c: { id: string }) => c.id);
  const departmentChannels = (Array.isArray(src.departmentChannels) ? src.departmentChannels : [])
    .map((c: any) => ({ department: String(c?.department ?? "").trim(), id: String(c?.id ?? "").trim() }))
    .filter((c: { department: string; id: string }) => c.department || c.id);
  for (const c of [...channels, ...departmentChannels]) {
    if (!SLACK_CHANNEL.test(c.id)) errors.push(`チャンネル ID「${c.id || "（空）"}」の形が違います（C で始まる英数字。チャンネル名ではなく ID）`);
  }
  for (const c of departmentChannels) if (!c.department) errors.push("部署名が空の行があります");

  const templates = {
    before: String(src.templates?.before ?? d.templates.before),
    overdue: String(src.templates?.overdue ?? d.templates.overdue)
  };
  const known = new Set(DELIVERY_ALERT_FIELDS.map((f) => f.name));
  for (const [kind, text] of Object.entries(templates)) {
    if (!text.trim()) errors.push(`${kind === "before" ? "納期前" : "超過"}の文面が空です`);
    for (const m of text.matchAll(/\{([^{}]+)\}/g)) {
      if (!known.has(m[1])) errors.push(`文面の {${m[1]}} は差し込めません（使えるのは ${[...known].join("・")}）`);
    }
  }
  if (templates.before.length > 3000 || templates.overdue.length > 3000) errors.push("文面は 3000 字までです");

  return {
    value: {
      enabled: bool(src.enabled, d.enabled),
      daysBefore,
      overdue: bool(src.overdue, d.overdue),
      overdueWeekdaysOnly: bool(src.overdueWeekdaysOnly, d.overdueWeekdaysOnly),
      overdueUntilDays: Number.isInteger(until) ? until : d.overdueUntilDays,
      notifyRequester: bool(src.notifyRequester, d.notifyRequester),
      notifyOwner: bool(src.notifyOwner, d.notifyOwner),
      channels, departmentChannels, templates
    },
    errors: [...new Set(errors)]
  };
}

/** 保存されている値を読む。壊れていても既定値で埋めて動かす（ジョブを止めない）。 */
export function readDeliveryAlertSettings(stored: unknown): DeliveryAlertSettings {
  return parseDeliveryAlertSettings(stored ?? DEFAULT_DELIVERY_ALERT).value;
}

/** {差込} を埋める。知らない差込はそのまま残す。 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (all, name) => (name in values ? values[name] : all));
}
