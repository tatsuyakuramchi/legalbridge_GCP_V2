/**
 * 通知先の1行（部署 ／ 氏名 ／ メール ／ 電話）。
 *
 * 紙には1行で出るが、1つの欄に「／」区切りで打たせると甲と乙で書き方が
 * 揃わない。画面は4つの欄で編集し、値は紙と同じ1行で持つ。その行き来と、
 * 候補から1つぶんだけ差し替える規則をここに置く（画面と文書の両方が使う）。
 */

export const CONTACT_SEP = " ／ ";

export interface ContactParts {
  department: string;
  name: string;
  email: string;
  phone: string;
}

/** 電話に見えるか。数字と区切り記号だけで、ある程度の長さがあるもの。 */
const looksPhone = (v: string) => /^[\d０-９+＋()（）\-‐－ー\s]{6,}$/.test(v);

/** 1行を4つに戻す。メールは @、電話は数字で見分け、残りは 部署・氏名 の順。 */
export function splitContact(line: string): ContactParts {
  const parts = String(line ?? "").split(/\s*[／/]\s*/).map((x) => x.trim()).filter(Boolean);
  const out: ContactParts = { department: "", name: "", email: "", phone: "" };
  const rest: string[] = [];
  for (const x of parts) {
    if (!out.email && x.includes("@")) out.email = x;
    else if (!out.phone && looksPhone(x)) out.phone = x;
    else rest.push(x);
  }
  if (rest.length >= 2) { out.department = rest[0]; out.name = rest.slice(1).join(" "); }
  else if (rest.length === 1) out.name = rest[0];
  return out;
}

export const joinContactParts = (v: ContactParts) =>
  [v.department, v.name, v.email, v.phone].map((x) => x.trim()).filter(Boolean).join(CONTACT_SEP);

/**
 * 候補を通知先の欄に入れる。
 *
 * 候補は「◯◯ のメール」のように1つぶんしか持っていない。欄の値は4つを畳んだ
 * 1行なので、そのまま入れ替えると、入れたつもりのない3つが消える。札と値から
 * 入る先を決めて、そこだけ差し替える。
 * 4つ揃った1行（前回の文言など）は、そのまま入れ替える。
 */
export function mergeContactPick(current: string, label: string, value: string): string {
  const v = String(value ?? "").trim();
  if (!v) return current;
  if (/[／/]/.test(v)) return v;
  const key: keyof ContactParts =
    /メール|mail/i.test(label) || v.includes("@") ? "email"
      : /電話|tel|phone/i.test(label) ? "phone"
        : /部署|部門|所属/.test(label) ? "department"
          : /氏名|名前|名称|担当者名/.test(label) ? "name"
            : looksPhone(v) ? "phone"
              : "name";
  return joinContactParts({ ...splitContact(current), [key]: v });
}
