/**
 * SPLL 公開サイトのデモ用データ。
 *
 * 本番では原作マスタ（Google Sheets の Works_Master）と料金表（Fee_Schedule）を
 * public projection へ同期して読むが、デモ段階ではDBもSheetsも要求せず、
 * このファイルだけでサイトが成立するようにしている。
 * 値は SPLL 側の初期シードと同じものを使い、画面の見え方を実データに近づけている。
 */

export interface SpllWork {
  workId: string;
  workName: string;
  publisher: string;
  licensor: string;
  category: string;
  okElements: string[];
  noElements: string[];
  creditText: string;
  media: string[];
}

export interface SpllFeeRule {
  usageCategory: string;
  feeModel: "FLAT" | "RATE";
  feeLabel: string;
  licensedUses: string;
  paymentDue: string;
  reportingRequirement: string;
  reportDue: string;
}

export interface SpllCertificate {
  certificateId: string;
  licenseId: string;
  status: "ACTIVE" | "PAYMENT_HOLD" | "REVOKED";
  workNames: string[];
  usageCategory: string;
  issuedAt: string;
}

export const SAMPLE_WORKS: SpllWork[] = [
  {
    workId: "WRK-ARK00012",
    workName: "新クトゥルフ神話TRPG",
    publisher: "アークライト／KADOKAWA",
    licensor: "アークライト",
    category: "TRPG / ルールブック",
    okElements: ["世界観・神話設定", "シナリオ"],
    noElements: ["公式イラストの流用", "ルールデータの転載"],
    creditText: "指定のシリーズ権利表記を記載",
    media: ["書籍", "電子書籍", "商品販売"]
  },
  {
    workId: "WRK-ARK00045",
    workName: "光砕のリヴァルチャー",
    publisher: "どらこにあん／アークライト",
    licensor: "どらこにあん",
    category: "TRPG / ルールブック",
    okElements: ["世界観設定", "シナリオ", "キャラクター名称"],
    noElements: ["公式イラストの流用"],
    creditText: "指定の権利表記を記載",
    media: ["書籍", "電子書籍", "商品販売"]
  },
  {
    workId: "WRK-BKK00019",
    workName: "インセイン",
    publisher: "冒険企画局",
    licensor: "冒険企画局",
    category: "TRPG / ルールブック",
    okElements: ["世界観設定", "ハンドアウト形式"],
    noElements: ["シナリオデータの転載"],
    creditText: "指定の権利表記を記載",
    media: ["電子書籍"]
  }
];

export const SAMPLE_FEES: SpllFeeRule[] = [
  {
    usageCategory: "書籍",
    feeModel: "FLAT",
    feeLabel: "16,500円／契約",
    licensedUses: "複製・頒布",
    paymentDue: "契約締結後の請求書発行日から30日以内",
    reportingRequirement: "定額のため利用報告は原則不要",
    reportDue: "－"
  },
  {
    usageCategory: "電子出版物",
    feeModel: "RATE",
    feeLabel: "売上の10％",
    licensedUses: "複製・公衆送信",
    paymentDue: "半期ごとの計算書発効後",
    reportingRequirement: "半期ごとに販売実績を報告",
    reportDue: "各半期終了後1ヶ月以内"
  },
  {
    usageCategory: "商品販売",
    feeModel: "FLAT",
    feeLabel: "16,500円／契約",
    licensedUses: "複製・頒布・販売",
    paymentDue: "契約締結後の請求書発行日から30日以内",
    reportingRequirement: "定額のため利用報告は原則不要",
    reportDue: "－"
  },
  {
    usageCategory: "サブスクリプション",
    feeModel: "RATE",
    feeLabel: "売上の10％",
    licensedUses: "公衆送信（継続的提供）",
    paymentDue: "半期ごとの計算書発効後",
    reportingRequirement: "半期ごとに売上を報告",
    reportDue: "各半期終了後1ヶ月以内"
  },
  {
    usageCategory: "イベント",
    feeModel: "FLAT",
    feeLabel: "無償（イベント頒布・要事前申告）",
    licensedUses: "頒布・上演",
    paymentDue: "－",
    reportingRequirement: "頒布実績を事後報告",
    reportDue: "イベント終了後1ヶ月以内"
  },
  {
    usageCategory: "その他",
    feeModel: "RATE",
    feeLabel: "売上の10％（個別協議）",
    licensedUses: "別途協議",
    paymentDue: "個別協議",
    reportingRequirement: "個別協議",
    reportDue: "個別協議"
  }
];

/** 検証ページの見え方を確認するためのサンプル。有効・一時停止の2状態を用意する。 */
export const SAMPLE_CERTIFICATES: SpllCertificate[] = [
  {
    certificateId: "CERT-DEMO-0042",
    licenseId: "SPLL-202608-0042",
    status: "ACTIVE",
    workNames: ["新クトゥルフ神話TRPG", "光砕のリヴァルチャー"],
    usageCategory: "電子出版物",
    issuedAt: "2026-08-11"
  },
  {
    certificateId: "CERT-DEMO-0041",
    licenseId: "SPLL-202608-0041",
    status: "PAYMENT_HOLD",
    workNames: ["光砕のリヴァルチャー"],
    usageCategory: "書籍",
    issuedAt: "2026-08-10"
  }
];

export function findWork(workId: string): SpllWork | undefined {
  return SAMPLE_WORKS.find((work) => work.workId === workId);
}

export function findFee(usageCategory: string): SpllFeeRule | undefined {
  return SAMPLE_FEES.find((fee) => fee.usageCategory === usageCategory);
}

export function findCertificate(certificateId: string): SpllCertificate | undefined {
  return SAMPLE_CERTIFICATES.find((certificate) => certificate.certificateId === certificateId);
}

/** 原作の全文検索（デモなので単純な部分一致）。 */
export function searchWorks(query: string): SpllWork[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return SAMPLE_WORKS;
  return SAMPLE_WORKS.filter((work) =>
    [work.workName, work.publisher, work.licensor, work.category, ...work.okElements]
      .join(" ").toLowerCase().includes(needle)
  );
}
