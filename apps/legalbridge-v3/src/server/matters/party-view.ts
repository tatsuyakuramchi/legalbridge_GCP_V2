import type { MatterDetail } from "../core/model.js";

/**
 * 案件を取引先ごとに見る。
 *
 * 1つの案件に取引先が20社以上ぶら下がることがある（作品1点を何社にも
 * 許諾する、1つの企画で何人もの作家に発注する）。条件明細・実績・文書・支払が
 * 社を問わず1本の並びで出るので、「この会社のぶんはどこまで進んだか」を
 * 追うのに目で拾うしかなかった。
 *
 * 絞り込みは画面の見せ方だけの話なので、元のデータは動かさない。選んだ社の
 * 条件・文書・支払だけを持つ写しを作って、各タブにはそれを渡す。
 */

export interface PartyTally {
  id: number;
  name: string;
  /** その社にぶら下がる数。選ぶ前に「どこに何があるか」を見せる。 */
  conditions: number;
  documents: number;
  payments: number;
}

/** 条件・文書・支払のどれかに出てくる取引先を、数と一緒に集める。 */
export function partiesOf(detail: MatterDetail): PartyTally[] {
  const found = new Map<number, PartyTally>();
  const touch = (id: number | null | undefined, name: string | null | undefined) => {
    if (!id) return null;
    const got = found.get(id) ?? { id, name: name ?? `#${id}`, conditions: 0, documents: 0, payments: 0 };
    // 名前が空のまま拾った行（支払は条件から引くので抜けることがある）は、
    // あとで名前の付いた行が来たら埋める。
    if (name && got.name.startsWith("#")) got.name = name;
    found.set(id, got);
    return got;
  };
  for (const c of detail.conditions) {
    const t = touch(c.counterparty?.id, c.counterparty?.name);
    if (t) t.conditions += 1;
  }
  for (const d of detail.documents) {
    const t = touch(d.counterpartyId, d.counterparty);
    if (t) t.documents += 1;
  }
  for (const p of detail.payments) {
    const t = touch(p.counterpartyId, p.counterparty);
    if (t) t.payments += 1;
  }
  // 条件の多い社から。件数が同じなら名前順で、並びが毎回変わらないようにする。
  return [...found.values()].sort((a, b) =>
    (b.conditions - a.conditions) || (b.documents - a.documents) || a.name.localeCompare(b.name, "ja"));
}

/**
 * 選んだ取引先のぶんだけにした写し。
 *
 * 相手先の分からない行（移行した古い文書など）は落とす。残すと「この社のぶん」
 * として読まれてしまい、絞り込んだ意味がなくなる。
 */
export function filterByParty(detail: MatterDetail, partyId: number | null): MatterDetail {
  if (!partyId) return detail;
  return {
    ...detail,
    conditions: detail.conditions.filter((c) => c.counterparty?.id === partyId),
    documents: detail.documents.filter((d) => d.counterpartyId === partyId),
    payments: detail.payments.filter((p) => p.counterpartyId === partyId)
  };
}
