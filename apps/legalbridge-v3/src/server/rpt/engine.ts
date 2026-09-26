/**
 * 関連当事者取引の判定。V1 の gas/related_party.html の判定エンジンをそのまま移したもの。
 *
 * 取引 A ⇄ B を2つの軸で見る。
 *   1. 会社法の利益相反・競業（356条）と、その承認の仕方（承認機関・除斥・役会不成立）
 *   2. 会計基準第11号の関連当事者（基準5項の区分）と、重要性の目安
 *
 * DB を触らない純関数。台帳（会社・株主構成・役員と役職）を渡して判定する。
 * 画面の判定と、議案を起票するときにサーバで判定し直すのと、同じものを使う。
 * ブラウザでも読むので、サーバ専用のものは import しない。
 */

export const TXN_TYPES: Array<{ id: string; label: string; kaishaho: string; disclose: string }> = [
  { id: "sale", label: "売買・物品提供", kaishaho: "直接取引(356①二)", disclose: "営業取引として開示対象" },
  { id: "service", label: "役務の提供・業務委託", kaishaho: "直接取引(356①二)", disclose: "営業取引として開示対象" },
  { id: "license", label: "ライセンス・知的財産の許諾", kaishaho: "直接取引(356①二)", disclose: "営業／営業外として開示対象" },
  { id: "lease", label: "賃貸借", kaishaho: "直接取引(356①二)", disclose: "営業外（賃借料）として開示対象" },
  { id: "loan", label: "金銭の貸借", kaishaho: "直接取引(356①二)", disclose: "営業外（利息・残高）。低利/無利息は時価で判定" },
  { id: "guarantee", label: "債務保証", kaishaho: "間接取引(356①三)", disclose: "営業外/オフバランス（被保証残高）" },
  { id: "collateral", label: "担保提供", kaishaho: "間接取引(356①三)", disclose: "対応債務残高で判定（担保受入も）" },
  { id: "asset", label: "資産の譲渡・譲受", kaishaho: "直接取引(356①二)＋362条4項一の通常決議", disclose: "特別損益。安値売却に注意" },
  { id: "capital", label: "出資・増減資・自己株式", kaishaho: "場面により直接/間接", disclose: "資本取引として開示（公募増資は対象外）" },
  { id: "waiver", label: "債権放棄・債務免除", kaishaho: "間接取引(356①三)に当たり得る", disclose: "特別損益（利益移転に注意）" },
  { id: "other", label: "その他", kaishaho: "個別判断", disclose: "関連当事者なら原則開示対象" }
];
export const OFFICER_TITLES = ["代表取締役", "取締役", "社外取締役", "監査役", "執行役員", "会計参与"] as const;
export const DIRECTOR_TITLES = ["代表取締役", "取締役", "社外取締役"];
/** 子会社（支配）・関連会社・主要株主の議決権の閾値（%）。 */
export const TH_SUB = 50, TH_AFFIL = 20, TH_MAJOR = 10;

export const txnLabel = (id: string) => TXN_TYPES.find((t) => t.id === id)?.label ?? id;

export interface Company {
  id: string;
  name: string;
  board: boolean;
  shareholders: Array<{ holderKind: "company" | "person"; holderId: string; pct: number }>;
}
export interface Director { id: string; name: string; roles: Array<{ companyId: string; title: string }> }
export interface Masters { companies: Company[]; directors: Director[] }
export interface PartyRef { kind: "company" | "person"; id: string }

export interface Finding {
  companyId: string; companyName: string; type: string; basis: string; detail: string;
  director?: string; self?: boolean;
}
export interface Approval {
  board: boolean; organ: "取締役会" | "株主総会"; excluded: string[]; total: number; baseCount: number; deadlock: boolean;
}
export interface Relation { category: string; note: string; ref: string; wholly?: boolean }
export interface Ownership { relation: "parent-sub" | "sibling"; parent: string; child?: string; pct?: number; wholly: boolean }
export interface Disclosure {
  related: boolean; rel?: Relation; personInvolved?: boolean;
  threshold?: number | null; amount?: number | null; materiality?: string;
}
export interface Judgement {
  a: PartyRef; b: PartyRef; aLabel: string; bLabel: string; txn: string; amount: number | null; competing: boolean;
  ownership: Ownership | null;
  conflict: { hit: boolean; findings: Finding[]; byCompany: Record<string, { companyName: string; items: Finding[] }> };
  method: Record<string, Approval>;
  disclosure: Disclosure;
}

export class RptEngine {
  constructor(private readonly m: Masters) {}

  private co(id: string) { return this.m.companies.find((c) => c.id === id) ?? null; }
  private dir(id: string) { return this.m.directors.find((d) => d.id === id) ?? null; }
  private isDirectorOf(d: Director, coId: string) {
    return d.roles.some((r) => r.companyId === coId && DIRECTOR_TITLES.includes(r.title));
  }
  private isRepOf(d: Director, coId: string) {
    return d.roles.some((r) => r.companyId === coId && r.title === "代表取締役");
  }
  /** holder が会社 coId の議決権を何 % 持つか。holder は会社でも役員でもよい（ID は種類ごとに別の空間）。 */
  pctHeld(holderId: string, coId: string, holderKind?: "company" | "person") {
    const c = this.co(coId);
    const s = c?.shareholders.find((x) => x.holderId === holderId && (!holderKind || x.holderKind === holderKind));
    return s ? Number(s.pct) || 0 : 0;
  }
  controllingParentId(coId: string): string | null {
    const top = (this.co(coId)?.shareholders ?? []).filter((x) => x.holderKind === "company")
      .slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))[0];
    return top && (Number(top.pct) || 0) > TH_SUB ? top.holderId : null;
  }
  controlChain(coId: string): string[] {
    const out: string[] = [];
    let cur: string | null = coId;
    for (let g = 0; cur && g < 20; g += 1) {
      const p = this.controllingParentId(cur);
      if (!p || out.includes(p)) break;
      out.push(p); cur = p;
    }
    return out;
  }

  label(p: PartyRef) {
    return p.kind === "company" ? this.co(p.id)?.name ?? "?" : this.dir(p.id)?.name ?? "?";
  }

  /** 会社の資本上の位置（一覧の見出し用）。 */
  classifyOwnership(c: Company): { label: string; tone: "" | "neg" | "amber" } {
    if (!c.shareholders.length) return { label: "独立／親会社未設定", tone: "" };
    const top = c.shareholders.filter((x) => x.holderKind === "company")
      .slice().sort((a, b) => (Number(b.pct) || 0) - (Number(a.pct) || 0))[0];
    const pct = top ? Number(top.pct) || 0 : 0;
    const p = top ? this.co(top.holderId)?.name ?? "親会社" : "";
    if (pct === 100) return { label: `完全子会社（${p} 100%）`, tone: "neg" };
    if (pct > TH_SUB) return { label: `子会社（${p} ${pct}%）`, tone: "amber" };
    if (pct >= TH_AFFIL) return { label: `関連会社（${p} ${pct}%）`, tone: "" };
    return { label: "独立／支配株主なし", tone: "" };
  }

  ownershipContext(a: PartyRef, b: PartyRef): Ownership | null {
    if (a.kind !== "company" || b.kind !== "company") return null;
    const ca = this.co(a.id), cb = this.co(b.id);
    if (!ca || !cb || ca.id === cb.id) return null;
    const aOfb = this.pctHeld(ca.id, cb.id, "company"), bOfa = this.pctHeld(cb.id, ca.id, "company");
    if (bOfa > TH_SUB) return { relation: "parent-sub", parent: cb.name, child: ca.name, pct: bOfa, wholly: bOfa === 100 };
    if (aOfb > TH_SUB) return { relation: "parent-sub", parent: ca.name, child: cb.name, pct: aOfb, wholly: aOfb === 100 };
    const pa = this.controllingParentId(ca.id), pb = this.controllingParentId(cb.id);
    if (pa && pa === pb) {
      return { relation: "sibling", parent: this.co(pa)?.name ?? "同一親会社",
               wholly: this.pctHeld(pa, ca.id, "company") === 100 && this.pctHeld(pa, cb.id, "company") === 100 };
    }
    return null;
  }

  analyzeConflict(pa: PartyRef, pb: PartyRef, txn: string, competing: boolean): Judgement["conflict"] {
    const findings: Finding[] = [];
    const cos = [pa, pb].filter((p) => p.kind === "company").map((p) => this.co(p.id)).filter(Boolean) as Company[];
    const persons = [pa, pb].filter((p) => p.kind === "person").map((p) => this.dir(p.id)).filter(Boolean) as Director[];

    // ① 直接取引：取締役本人 ⇔ 自社
    for (const d of persons) for (const c of cos) if (this.isDirectorOf(d, c.id)) {
      findings.push({ companyId: c.id, companyName: c.name, type: "直接取引", basis: "会社法356条1項2号",
        detail: `${d.name} は ${c.name} の取締役で、自己のために当該会社と取引。`, director: d.name, self: true });
    }

    // ② 兼任（代表権で段階化：双方代表／片面代表／無代表）
    if (cos.length === 2) {
      const [c1, c2] = cos;
      for (const d of this.m.directors) {
        if (!(this.isDirectorOf(d, c1.id) && this.isDirectorOf(d, c2.id))) continue;
        const r1 = this.isRepOf(d, c1.id), r2 = this.isRepOf(d, c2.id);
        if (r1 && r2) {
          for (const c of [c1, c2]) findings.push({ companyId: c.id, companyName: c.name, type: "双方代表",
            basis: "会社法356条1項2号・民法108条",
            detail: `${d.name} は ${c1.name} と ${c2.name} の双方を代表（双方代理）。両社で承認を要する。`, director: d.name });
        } else if (r1 || r2) {
          const rep = r1 ? c1 : c2, other = r1 ? c2 : c1;
          findings.push({ companyId: other.id, companyName: other.name, type: "直接取引（相手方を代表）", basis: "会社法356条1項2号",
            detail: `${d.name} は ${other.name} の取締役であり、相手方 ${rep.name} を代表。${other.name} で承認が必要。`, director: d.name });
          findings.push({ companyId: rep.id, companyName: rep.name, type: "利益相反（保守）", basis: "会社法356条1項3号参照",
            detail: `${d.name} は ${rep.name} を代表。利益相反のおそれがあり保守的に ${rep.name} でも承認が安全。`, director: d.name });
        } else {
          for (const c of [c1, c2]) findings.push({ companyId: c.id, companyName: c.name, type: "利益相反（無代表兼任）",
            basis: "会社法356条1項2号参照",
            detail: `${d.name} は ${c1.name}・${c2.name} の平取締役を兼任。形式的該当性は弱いが意思決定関与のおそれから保守的に承認・除斥。`,
            director: d.name });
        }
      }
    }

    // ③ 支配経由：取締役が相手方会社を支配＝計算説の実質自己取引
    if (cos.length === 2) {
      const [d1, d2] = cos;
      for (const d of this.m.directors) {
        for (const [mine, theirs] of [[d1, d2], [d2, d1]] as const) {
          const pct = this.pctHeld(d.id, theirs.id, "person");
          if (this.isDirectorOf(d, mine.id) && !this.isDirectorOf(d, theirs.id) && pct > TH_SUB) {
            findings.push({ companyId: mine.id, companyName: mine.name, type: "間接取引（支配）", basis: "会社法356条1項2号・3号",
              detail: `${d.name} は ${mine.name} の取締役で、相手方 ${theirs.name} を議決権 ${pct}% で支配。計算説により実質「自己のための取引」。`,
              director: d.name });
          }
        }
      }
    }

    // ④ 間接取引（債務保証・担保提供）
    if (txn === "guarantee" || txn === "collateral") {
      for (const d of persons) for (const c of cos) if (this.isDirectorOf(d, c.id)) {
        findings.push({ companyId: c.id, companyName: c.name, type: "間接取引", basis: "会社法356条1項3号",
          detail: `${c.name} が取締役 ${d.name} の債務を保証する等、会社と取締役の利益が相反する取引。`, director: d.name });
      }
    }

    // ⑤ 競業取引
    if (competing) {
      for (const d of persons) for (const c of cos) if (this.isDirectorOf(d, c.id)) {
        findings.push({ companyId: c.id, companyName: c.name, type: "競業取引", basis: "会社法356条1項1号",
          detail: `${d.name}（${c.name} 取締役）が会社の事業の部類に属する取引を行う。`, director: d.name });
      }
    }

    const byCompany: Judgement["conflict"]["byCompany"] = {};
    for (const f of findings) {
      (byCompany[f.companyId] ??= { companyName: f.companyName, items: [] }).items.push(f);
    }
    return { hit: findings.length > 0, findings, byCompany };
  }

  /** 承認の方法：承認機関・除斥・除斥後に議決できるか・役会不成立なら株主総会。 */
  approvalMethod(byCompany: Judgement["conflict"]["byCompany"]): Record<string, Approval> {
    const out: Record<string, Approval> = {};
    for (const cid of Object.keys(byCompany)) {
      const board = Boolean(this.co(cid)?.board);
      const excluded: string[] = [];
      for (const f of byCompany[cid].items) if (f.director && !excluded.includes(f.director)) excluded.push(f.director);
      const names = this.m.directors.filter((d) => this.isDirectorOf(d, cid)).map((d) => d.name);
      const baseCount = names.filter((n) => !excluded.includes(n)).length;
      out[cid] = { board, organ: board ? "取締役会" : "株主総会", excluded, total: names.length, baseCount,
                   deadlock: board && baseCount === 0 };
    }
    return out;
  }

  relationBetween(a: PartyRef, b: PartyRef): Relation | null {
    if (a.kind === "company" && b.kind === "company") {
      const ca = this.co(a.id), cb = this.co(b.id);
      if (!ca || !cb || ca.id === cb.id) return null;
      const aOfb = this.pctHeld(ca.id, cb.id, "company"), bOfa = this.pctHeld(cb.id, ca.id, "company");
      if (bOfa > TH_SUB) return { category: `親会社${bOfa === 100 ? "（完全子会社・連結相殺）" : ""}`,
        note: `${cb.name} が ${ca.name} の議決権 ${bOfa}% を保有`, ref: "基準5項(1)", wholly: bOfa === 100 };
      if (aOfb > TH_SUB) return { category: `子会社${aOfb === 100 ? "（完全子会社・連結相殺）" : ""}`,
        note: `${ca.name} が ${cb.name} の議決権 ${aOfb}% を保有`, ref: "基準5項(2)", wholly: aOfb === 100 };
      const chainA = [ca.id, ...this.controlChain(ca.id)], chainB = [cb.id, ...this.controlChain(cb.id)];
      if (chainA.includes(cb.id)) return { category: "親会社（間接）", note: `${cb.name} は ${ca.name} の支配株主チェーン上`, ref: "基準5項(1)" };
      if (chainB.includes(ca.id)) return { category: "子会社（間接）", note: `${ca.name} は ${cb.name} の支配株主チェーン上`, ref: "基準5項(2)" };
      const pa = this.controllingParentId(ca.id), pb = this.controllingParentId(cb.id);
      if (pa && pa === pb) return { category: "兄弟会社（同一の親会社をもつ会社）",
        note: `両社とも ${this.co(pa)?.name ?? "同一親会社"} の子会社`, ref: "基準5項(3)" };
      if (bOfa >= TH_AFFIL) return { category: "関連会社（被影響側）", note: `${cb.name} が ${ca.name} の議決権 ${bOfa}% を保有`, ref: "基準5項(4)" };
      if (aOfb >= TH_AFFIL) return { category: "関連会社", note: `${ca.name} が ${cb.name} の議決権 ${aOfb}% を保有`, ref: "基準5項(4)" };
      return null;
    }
    const coRef = a.kind === "company" ? a : b, per = a.kind === "person" ? a : b;
    if (coRef.kind !== "company" || per.kind !== "person") return null;
    const c = this.co(coRef.id), d = this.dir(per.id);
    if (!c || !d) return null;
    const role = d.roles.find((r) => r.companyId === c.id);
    const own = this.pctHeld(d.id, c.id, "person");
    if (role && own >= TH_MAJOR) return { category: "役員かつ主要株主",
      note: `${d.name} は ${c.name} の${role.title}、かつ議決権 ${own}% を保有`, ref: "基準5項(5)(6)" };
    if (role) return { category: "役員（及びその近親者）", note: `${d.name} は ${c.name} の${role.title}`, ref: "基準5項(6)" };
    if (own >= TH_MAJOR) return { category: "主要株主（及びその近親者）", note: `${d.name} は ${c.name} の議決権 ${own}% を保有`, ref: "基準5項(5)" };
    if (d.roles.length) {
      const chain = this.controlChain(c.id), parent = this.controllingParentId(c.id);
      const linked = d.roles.map((r) => r.companyId).find((cid) => chain.includes(cid) || cid === parent);
      if (linked) return { category: "親会社等の役員",
        note: `${d.name} は ${this.co(linked)?.name ?? "親会社"}（${c.name} の支配株主側）の役員`, ref: "基準5項(6)・(8)参照" };
    }
    return null;
  }

  analyzeDisclosure(a: PartyRef, b: PartyRef, amount: number | null,
                    thresholds: { company: number | null; person: number | null }): Disclosure {
    const rel = this.relationBetween(a, b);
    if (!rel) return { related: false };
    const personInvolved = a.kind === "person" || b.kind === "person";
    const threshold = personInvolved ? thresholds.person : thresholds.company;
    const hasTh = threshold !== null && Number.isFinite(threshold) && threshold > 0;
    let materiality = "要判断";
    if (amount !== null && hasTh) materiality = amount > threshold! ? "重要（開示対象の目安）" : "重要性基準未満（目安）";
    return { related: true, rel, personInvolved, threshold: hasTh ? threshold : null, amount, materiality };
  }

  judge(input: { a: PartyRef; b: PartyRef; txn: string; amount: number | null; competing: boolean;
                 thresholds: { company: number | null; person: number | null } }): Judgement {
    const conflict = this.analyzeConflict(input.a, input.b, input.txn, input.competing);
    return {
      a: input.a, b: input.b, aLabel: this.label(input.a), bLabel: this.label(input.b),
      txn: input.txn, amount: input.amount, competing: input.competing,
      ownership: this.ownershipContext(input.a, input.b),
      conflict,
      method: this.approvalMethod(conflict.byCompany),
      disclosure: this.analyzeDisclosure(input.a, input.b, input.amount, input.thresholds)
    };
  }
}
