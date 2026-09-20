import type { PartyTally } from "../server/matters/party-view.js";

/**
 * 案件を取引先ごとに見る（案件の中身のタブの上）。
 *
 * 1つの案件に取引先が20社以上ぶら下がることがある。条件明細・実績・文書・支払が
 * 社を問わず1本の並びで出ると、「この会社のぶんはどこまで進んだか」を目で
 * 拾うしかない。ここで1社を選ぶと、4つのタブが揃ってその社のぶんだけになる。
 *
 * 20社を札で並べると何行にもなるので、選ぶのは一覧から。選んでいる間は
 * 何件ずつ残っているかを添えて、絞っていること自体を見失わないようにする。
 */
export function MatterPartyFilter(
  { parties, value, onChange }: {
    parties: PartyTally[];
    value: number | null;
    onChange: (partyId: number | null) => void;
  }
) {
  // 1社だけの案件で出しても選ぶものが無い。混乱するのは複数社のときだけ。
  if (parties.length < 2) return null;
  const current = parties.find((p) => p.id === value) ?? null;

  return (
    <div className="party-filter">
      <label className="party-label" htmlFor="matter-party-filter">取引先で絞る</label>
      <select id="matter-party-filter" value={value ?? ""}
              onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">すべての取引先（{parties.length} 社）</option>
        {parties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}（条件 {p.conditions}・文書 {p.documents}・支払 {p.payments}）
          </option>
        ))}
      </select>
      {current
        ? <>
            <span className="tag accent">{current.name} だけ</span>
            <span className="party-note">
              条件明細・実績・文書・支払がこの社のぶんだけになります
            </span>
            <button type="button" className="linky" onClick={() => onChange(null)}>すべてに戻す</button>
          </>
        : <span className="party-note">
            この案件には {parties.length} 社の取引先があります。1社を選ぶと4つのタブが揃って絞り込まれます
          </span>}
    </div>
  );
}
