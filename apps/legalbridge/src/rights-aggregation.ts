// 権利ツリー（R3）とライセンスマトリクス（R4）の共通集計層。純関数・DB/画面非依存。
//
// 画面は V1 から再設計するが、**判定ルールは V1 を引き継ぐ**（workModel.ts の
// /api/v3/works/:id/rights-tree の集計を移植）。特に広域許諾×個別許諾の重複警告は
// 二重許諾の検知手段そのものなので、UI が変わっても消してはいけない。
//
// データ源は condition_lines（V1/V2 共有）。地域・言語は「・」等で連結された複数値を
// 持ち得るため、集計前に国・言語単位へ分解する（V1 0133 と同じ区切り文字）。

export interface RightsLine {
  id: number;
  direction: "receivable" | "payable" | null;
  /** condition_name ?? subject ?? "(無題)" をリポジトリ側で解決して渡す。 */
  name: string;
  party: string | null;
  paymentScheme: string | null;
  calcMethod: string | null;
  ratePct: number | null;
  mgAmount: number | null;
  amountExTax: number | null;
  currency: string | null;
  formulaText: string | null;
  territory: string | null;
  language: string | null;
  documentNumber: string | null;
  /** 独占区分（exclusive/sole/non_exclusive）。V1 由来の行や未設定は null。 */
  exclusivity?: string | null;
  /** 許諾期間。開始/終了とも null は無期限扱い。 */
  termStart?: string | null;
  termEnd?: string | null;
  // マトリクス（横断）用。単一作品のツリーでは未使用。
  workId?: number;
  workTitle?: string;
}

export type RightKind = "buyout" | "running" | "free";

export interface ClassifiedRight extends RightsLine {
  kind: RightKind;
  amountLabel: string | null;
  /** running のときの計算条件表示（MG ¥x ＋ y% など）。free は「無償」。buyout は null。 */
  calcLabel: string | null;
}

export interface TerritorySummaryEntry {
  territory: string;
  languages: string[];
  rights: string[];
}

export interface RightsTree {
  acquired: ClassifiedRight[];   // payable ＝ 当社が支払って取得した権利
  granted: ClassifiedRight[];    // receivable ＝ 当社が許諾して受領する権利
  territorySummary: TerritorySummaryEntry[];
  /** 広域許諾（全世界等）と特定地域で同一言語が重なる箇所。「地域（言語）」形式。 */
  overlaps: string[];
  totals: {
    buyoutCount: number;
    buyoutAmount: number;
    acquiredCount: number;
    grantedCount: number;
  };
}

const RUNNING_SCHEMES = new Set(["royalty", "subscription", "per_unit", "installment"]);
const RUNNING_METHODS = new Set(["ROYALTY", "SUBSCRIPTION", "PER_UNIT", "INSTALLMENT"]);

export function yen(value: number): string {
  return "¥" + Math.round(value).toLocaleString("ja-JP");
}

// ランニング判定（V1 isRunning をそのまま）。スキーム／計算方式のどちらかが
// 継続型、または料率か MG を持てばランニング。
export function isRunningRight(line: RightsLine): boolean {
  const scheme = String(line.paymentScheme ?? "").toLowerCase();
  const method = String(line.calcMethod ?? "").toUpperCase();
  return (
    RUNNING_SCHEMES.has(scheme) ||
    RUNNING_METHODS.has(method) ||
    line.ratePct != null ||
    (line.mgAmount != null && Number(line.mgAmount) > 0)
  );
}

// 計算条件の表示（V1 calcLabel をそのまま）。料率0は「印税 0%」と出さない。
export function runningCalcLabel(line: RightsLine): string {
  const rate = line.ratePct != null ? Number(line.ratePct) : null;
  const mg = line.mgAmount != null && Number(line.mgAmount) > 0 ? Number(line.mgAmount) : null;
  if (rate != null && rate !== 0) return mg ? `MG ${yen(mg)} ＋ ${rate}%` : `印税 ${rate}%`;
  if (mg) return `MG ${yen(mg)}`;
  if (line.formulaText) return String(line.formulaText);
  if (String(line.paymentScheme ?? "").toLowerCase() === "subscription") return "定期課金";
  return "計算条件あり";
}

export function classifyRight(line: RightsLine): ClassifiedRight {
  const running = isRunningRight(line);
  const amount = line.amountExTax != null ? Number(line.amountExTax) : null;
  const kind: RightKind = running ? "running" : amount && amount > 0 ? "buyout" : "free";
  return {
    ...line,
    party: line.party || "(取引先未設定)",
    kind,
    amountLabel: amount != null ? yen(amount) : null,
    calcLabel: kind === "running" ? runningCalcLabel(line) : kind === "free" ? "無償" : null
  };
}

// 「・」「,」「/」「／」「、」区切りの複数値を分解（V1 0133 と同じ）。
export function splitTerms(value: string | null | undefined): string[] {
  return String(value ?? "").split(/[・,\/／、]/).map((v) => v.trim()).filter(Boolean);
}

// 許諾地域サマリー：地域 → 言語ロールアップ＋対象権利（V1 と同じ出現順を保つ）。
export function buildTerritorySummary(granted: RightsLine[]): TerritorySummaryEntry[] {
  const map = new Map<string, TerritorySummaryEntry>();
  for (const grant of granted) {
    const territories = splitTerms(grant.territory);
    const list = territories.length ? territories : ["（地域未設定）"];
    const languages = splitTerms(grant.language ?? "—");
    for (const territory of list) {
      let entry = map.get(territory);
      if (!entry) { entry = { territory, languages: [], rights: [] }; map.set(territory, entry); }
      for (const language of languages) {
        if (language && !entry.languages.includes(language)) entry.languages.push(language);
      }
      if (!entry.rights.includes(grant.name)) entry.rights.push(grant.name);
    }
  }
  return [...map.values()];
}

// 広域許諾の判定語（V1 と同じ）。地域名にこれらを含めば「全世界」的な許諾とみなす。
const WORLDWIDE_TERMS = ["全世界", "世界", "worldwide", "global", "all"];

export function isWorldwideTerritory(territory: string): boolean {
  const lower = territory.toLowerCase();
  return WORLDWIDE_TERMS.some((term) => lower.includes(term.toLowerCase()));
}

// 重複警告（V1 と同じ）：全世界的な許諾と特定地域の許諾で同一言語が重なれば
// 「地域（言語）」を返す。二重許諾の可能性＝要確認箇所。
export function findWideGrantOverlaps(summary: TerritorySummaryEntry[]): string[] {
  const world = summary.find((entry) => isWorldwideTerritory(entry.territory));
  if (!world) return [];
  const overlaps: string[] = [];
  for (const entry of summary) {
    if (entry === world) continue;
    for (const language of entry.languages) {
      if (world.languages.includes(language)) overlaps.push(`${entry.territory}（${language}）`);
    }
  }
  return overlaps;
}

export function buildRightsTree(lines: RightsLine[]): RightsTree {
  const classified = lines.map(classifyRight);
  const acquired = classified.filter((line) => line.direction === "payable");
  const granted = classified.filter((line) => line.direction === "receivable");
  const territorySummary = buildTerritorySummary(granted);
  const buyouts = acquired.filter((line) => line.kind === "buyout");
  return {
    acquired,
    granted,
    territorySummary,
    overlaps: findWideGrantOverlaps(territorySummary),
    totals: {
      buyoutCount: buyouts.length,
      buyoutAmount: buyouts.reduce((sum, line) => sum + (line.amountExTax ?? 0), 0),
      acquiredCount: acquired.length,
      grantedCount: granted.length
    }
  };
}

// ── ライセンスマトリクス（R4・横断）────────────────────────────────
// 作品×地域のセルに、許諾している言語・権利・相手先を集約する。
// 「どの作品がどの地域でまだ空いているか／誰に出しているか」を一望する用途。

export interface MatrixCell {
  languages: string[];
  rights: string[];
  parties: string[];
  documentNumbers: string[];
}

export interface LicenseMatrixRow {
  workId: number;
  workTitle: string;
  cells: Record<string, MatrixCell>;
  /** この作品の重複警告（ツリーと同じ判定）。 */
  overlaps: string[];
}

export interface LicenseMatrix {
  /** 列＝地域。広域（全世界等）を先頭に、あとは出現順。 */
  territories: string[];
  rows: LicenseMatrixRow[];
}

export function buildLicenseMatrix(lines: RightsLine[]): LicenseMatrix {
  const granted = lines.filter((line) => line.direction === "receivable" && line.workId != null);
  const byWork = new Map<number, { title: string; lines: RightsLine[] }>();
  for (const line of granted) {
    const entry = byWork.get(line.workId!) ?? { title: line.workTitle ?? `#${line.workId}`, lines: [] };
    entry.lines.push(line);
    byWork.set(line.workId!, entry);
  }

  const territoryOrder: string[] = [];
  const rows: LicenseMatrixRow[] = [];
  for (const [workId, work] of byWork) {
    const cells: Record<string, MatrixCell> = {};
    for (const line of work.lines) {
      const territories = splitTerms(line.territory);
      const list = territories.length ? territories : ["（地域未設定）"];
      const languages = splitTerms(line.language ?? "—");
      for (const territory of list) {
        if (!territoryOrder.includes(territory)) territoryOrder.push(territory);
        const cell = cells[territory] ?? { languages: [], rights: [], parties: [], documentNumbers: [] };
        for (const language of languages) {
          if (language && !cell.languages.includes(language)) cell.languages.push(language);
        }
        if (!cell.rights.includes(line.name)) cell.rights.push(line.name);
        const party = line.party || "(取引先未設定)";
        if (!cell.parties.includes(party)) cell.parties.push(party);
        if (line.documentNumber && !cell.documentNumbers.includes(line.documentNumber)) {
          cell.documentNumbers.push(line.documentNumber);
        }
        cells[territory] = cell;
      }
    }
    rows.push({
      workId,
      workTitle: work.title,
      cells,
      overlaps: findWideGrantOverlaps(buildTerritorySummary(work.lines))
    });
  }

  // 広域を先頭へ（マトリクスの読み順：まず全世界許諾の有無、次に個別地域）。
  const territories = [
    ...territoryOrder.filter(isWorldwideTerritory),
    ...territoryOrder.filter((territory) => !isWorldwideTerritory(territory))
  ];
  return { territories, rows };
}

// ── アウト側の許諾地域カバレッジ（R3 強化・2026-08-18）─────────────────
// 許諾地域の被りは二重許諾＝致命的。V1 の警告（全世界×個別地域の同一言語）に加えて、
// 「同一地域×同一言語×同一権利を複数明細で出している」ケースを衝突として検知する。
// 独占/非独占の区分が condition_lines に無いため、機械判定は「要確認」までとし、
// 相手先と文書番号を並べて人が判断できる形で返す。

export interface GrantCell {
  right: string;
  party: string;
  documentNumber: string | null;
  lineId: number;
  exclusivity: string | null;
  termStart: string | null;
  termEnd: string | null;
}

export function exclusivityLabel(value: string | null | undefined): string | null {
  if (value === "exclusive") return "独占";
  if (value === "sole") return "独占（自社実施可）";
  if (value === "non_exclusive") return "非独占";
  return null;   // 未設定（V1 由来など）
}

// 期間の重なり判定。null は無期限（開始なし＝過去から／終了なし＝将来まで）として扱う。
// 期間が重ならない許諾同士（例: 2024年で終了→2026年から別社）は被りではない。
export function termsOverlap(
  a: { termStart?: string | null; termEnd?: string | null },
  b: { termStart?: string | null; termEnd?: string | null }
): boolean {
  const aStart = a.termStart ?? "";        // "" はどの日付よりも小さい＝無期限開始
  const bStart = b.termStart ?? "";
  const aEnd = a.termEnd ?? "9999-12-31";  // 無期限終了
  const bEnd = b.termEnd ?? "9999-12-31";
  return aStart <= bEnd && bStart <= aEnd;
}

// 独占区分から見た「同じセルに複数許諾があってよいか」。
//   - 双方が非独占＝正常な併存（衝突にしない）
//   - どちらかが独占/独占(自社実施可)＝衝突（error）
//   - どちらかが未設定＝判定できない＝疑いとして衝突（error・区分の入力を促す）
function pairConflicts(a: GrantCell, b: GrantCell): boolean {
  if (!termsOverlap(a, b)) return false;
  if (a.exclusivity === "non_exclusive" && b.exclusivity === "non_exclusive") return false;
  return true;
}

export interface GrantCoverageRow {
  territory: string;
  isWorldwide: boolean;
  /** 言語 → その地域・言語で出している許諾の一覧。 */
  languages: Record<string, GrantCell[]>;
}

export interface GrantConflict {
  /** error=同一権利の重複許諾（致命的の疑い） / warning=同一言語圏の広域×個別（V1 相当） */
  severity: "error" | "warning";
  territory: string;
  language: string;
  right: string | null;
  parties: string[];
  documentNumbers: string[];
  message: string;
}

export interface GrantCoverage {
  rows: GrantCoverageRow[];       // 全世界を先頭に、あとは出現順
  languages: string[];            // 全行の言語（列見出し用・出現順）
  conflicts: GrantConflict[];     // error を先に
}

export function buildGrantCoverage(granted: RightsLine[]): GrantCoverage {
  const rowMap = new Map<string, GrantCoverageRow>();
  const languageOrder: string[] = [];
  for (const grant of granted) {
    const territories = splitTerms(grant.territory);
    const territoryList = territories.length ? territories : ["（地域未設定）"];
    const languages = splitTerms(grant.language);
    const languageList = languages.length ? languages : ["（言語未設定）"];
    for (const territory of territoryList) {
      let row = rowMap.get(territory);
      if (!row) {
        row = { territory, isWorldwide: isWorldwideTerritory(territory), languages: {} };
        rowMap.set(territory, row);
      }
      for (const language of languageList) {
        if (!languageOrder.includes(language)) languageOrder.push(language);
        (row.languages[language] ??= []).push({
          right: grant.name,
          party: grant.party || "(取引先未設定)",
          documentNumber: grant.documentNumber,
          lineId: grant.id,
          exclusivity: grant.exclusivity ?? null,
          termStart: grant.termStart ?? null,
          termEnd: grant.termEnd ?? null
        });
      }
    }
  }

  const rows = [...rowMap.values()].sort((a, b) =>
    Number(b.isWorldwide) - Number(a.isWorldwide));

  const conflicts: GrantConflict[] = [];
  const seen = new Set<string>();
  const push = (conflict: GrantConflict) => {
    const key = `${conflict.severity}|${conflict.territory}|${conflict.language}|${conflict.right ?? ""}`;
    if (!seen.has(key)) { seen.add(key); conflicts.push(conflict); }
  };

  const worldRows = rows.filter((row) => row.isWorldwide);
  for (const row of rows) {
    for (const [language, cells] of Object.entries(row.languages)) {
      // (1) 同一地域×同一言語×同一権利が複数明細 → 重複許諾の疑い（error）。
      //     同じ文書の中での重複行は運用上あり得る（改定・分割）ため、明細IDが違えば数える。
      const byRight = new Map<string, GrantCell[]>();
      for (const cell of cells) (byRight.get(cell.right) ?? byRight.set(cell.right, []).get(cell.right)!).push(cell);
      for (const [right, group] of byRight) {
        if (group.length < 2) continue;
        // ペア単位で判定：非独占同士の併存・期間が重ならない許諾は正常。
        const conflicted = group.filter((cell, index) =>
          group.some((other, otherIndex) => otherIndex !== index && pairConflicts(cell, other)));
        if (conflicted.length < 2) continue;
        const unknown = conflicted.some((cell) => exclusivityLabel(cell.exclusivity) == null);
        push({
          severity: "error", territory: row.territory, language, right,
          parties: [...new Set(conflicted.map((cell) => cell.party))],
          documentNumbers: [...new Set(conflicted.map((cell) => cell.documentNumber).filter((n): n is string => !!n))],
          message: `${row.territory}（${language}）の「${right}」を複数の明細で許諾しています` +
            (unknown ? "（独占区分が未設定の明細があるため要確認）" : "（独占許諾を含む）")
        });
      }
      // (2) 広域行との突き合わせ（個別地域側から見る）。
      if (!row.isWorldwide) {
        for (const world of worldRows) {
          const worldCells = world.languages[language] ?? [];
          if (!worldCells.length) continue;
          for (const cell of cells) {
            const sameRight = worldCells.filter((worldCell) =>
              worldCell.right === cell.right && pairConflicts(cell, worldCell));
            if (sameRight.length) {
              push({
                severity: "error", territory: row.territory, language, right: cell.right,
                parties: [...new Set([cell.party, ...sameRight.map((worldCell) => worldCell.party)])],
                documentNumbers: [...new Set([cell.documentNumber, ...sameRight.map((worldCell) => worldCell.documentNumber)]
                  .filter((n): n is string => !!n))],
                message: `「${cell.right}」（${language}）は${world.territory}許諾と${row.territory}許諾が重なっています`
              });
            } else {
              // 権利名は違うが同一言語圏が広域と重なる＝V1 相当の注意喚起。
              push({
                severity: "warning", territory: row.territory, language, right: null,
                parties: [...new Set([cell.party, ...worldCells.map((worldCell) => worldCell.party)])],
                documentNumbers: [],
                message: `${row.territory}（${language}）は${world.territory}許諾と言語圏が重なっています（権利は別）`
              });
            }
          }
        }
      }
    }
  }
  conflicts.sort((a, b) => Number(a.severity === "warning") - Number(b.severity === "warning"));
  return { rows, languages: languageOrder, conflicts };
}
