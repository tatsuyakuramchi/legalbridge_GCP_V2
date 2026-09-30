/**
 * 取込文書（外で作った文書）の種別と、その種別の文書番号の接頭辞。
 *
 * 法務がワンオフで作る文書は、番号を先に取って本文に書き込んでから登録する。
 * 番号は ARC-<接頭辞>-<年>-<連番> で、接頭辞は種別ごと。ひな形から出す文書の
 * 接頭辞（PO・RS）とは重ねない（連番の帯を分けておくため）。
 */
export interface ImportKind { kind: string; prefix: string }

export const IMPORT_KINDS: ImportKind[] = [
  { kind: "業務委託契約書", prefix: "SVC" },
  { kind: "秘密保持契約書", prefix: "NDA" },
  { kind: "発注書", prefix: "EPO" },
  { kind: "発注請書", prefix: "POA" },
  { kind: "検収書", prefix: "EAC" },
  { kind: "覚書", prefix: "MOU" },
  { kind: "念書", prefix: "LOU" },
  { kind: "通知書", prefix: "NTC" },
  { kind: "利用許諾契約書", prefix: "LIC" },
  { kind: "その他", prefix: "IMP" }
];

/** 種別が表に無い（古い登録・自由記述）ときは従来どおり IMP。 */
export function prefixForKind(kind: string | null | undefined): string {
  const k = String(kind ?? "").trim();
  return IMPORT_KINDS.find((x) => x.kind === k)?.prefix ?? "IMP";
}
