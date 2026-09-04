// 許諾地域・言語のマスタ（条件台帳の複数選択用・2026-09-04）。
// 国名は ISO 3166-1 alpha-2、言語は ISO 639-1 をコードに持つ。台帳の子テーブル
// （condition_line_regions / condition_line_languages）に code+name で保存し、
// 条件書・契約の Territory / Language 欄にはそのまま名前を並べて差し込む。
// 「まとめ」（全世界・アジア等）は地域名として1件で持つ（ライセンスマトリクスの
// 広域判定 WORLDWIDE_TERMS と同じ語）。

import type { CodedName } from "../condition-ledger";

export interface TerritoryGroup { label: string; items: CodedName[] }

const c = (code: string, name: string): CodedName => ({ code, name });

export const TERRITORY_PRESETS: CodedName[] = [
  c("WW", "全世界"), c("WW-XJP", "全世界（日本を除く）"), c("R-ASIA", "アジア"), c("R-EAST-ASIA", "東アジア"),
  c("R-SEA", "東南アジア"), c("R-EU", "欧州"), c("R-NA", "北米"), c("R-LATAM", "中南米"),
  c("R-OCEANIA", "オセアニア"), c("R-MEA", "中東・アフリカ"), c("R-CJK", "日中韓・台湾・香港")
];

export const COUNTRY_GROUPS: TerritoryGroup[] = [
  { label: "東アジア", items: [
    c("JP", "日本"), c("CN", "中国"), c("HK", "香港"), c("MO", "マカオ"), c("TW", "台湾"), c("KR", "韓国"), c("KP", "北朝鮮"), c("MN", "モンゴル")
  ] },
  { label: "東南アジア", items: [
    c("SG", "シンガポール"), c("MY", "マレーシア"), c("TH", "タイ"), c("VN", "ベトナム"), c("ID", "インドネシア"), c("PH", "フィリピン"),
    c("KH", "カンボジア"), c("LA", "ラオス"), c("MM", "ミャンマー"), c("BN", "ブルネイ"), c("TL", "東ティモール")
  ] },
  { label: "南アジア", items: [
    c("IN", "インド"), c("PK", "パキスタン"), c("BD", "バングラデシュ"), c("LK", "スリランカ"), c("NP", "ネパール"), c("BT", "ブータン"), c("MV", "モルディブ")
  ] },
  { label: "中央アジア・コーカサス", items: [
    c("KZ", "カザフスタン"), c("UZ", "ウズベキスタン"), c("KG", "キルギス"), c("TJ", "タジキスタン"), c("TM", "トルクメニスタン"),
    c("GE", "ジョージア"), c("AM", "アルメニア"), c("AZ", "アゼルバイジャン")
  ] },
  { label: "中東", items: [
    c("TR", "トルコ"), c("IL", "イスラエル"), c("AE", "アラブ首長国連邦"), c("SA", "サウジアラビア"), c("QA", "カタール"), c("KW", "クウェート"),
    c("BH", "バーレーン"), c("OM", "オマーン"), c("JO", "ヨルダン"), c("LB", "レバノン"), c("IQ", "イラク"), c("IR", "イラン"), c("SY", "シリア"), c("YE", "イエメン"), c("PS", "パレスチナ")
  ] },
  { label: "西欧・北欧", items: [
    c("GB", "イギリス"), c("IE", "アイルランド"), c("FR", "フランス"), c("DE", "ドイツ"), c("NL", "オランダ"), c("BE", "ベルギー"), c("LU", "ルクセンブルク"),
    c("CH", "スイス"), c("AT", "オーストリア"), c("LI", "リヒテンシュタイン"), c("MC", "モナコ"),
    c("SE", "スウェーデン"), c("NO", "ノルウェー"), c("DK", "デンマーク"), c("FI", "フィンランド"), c("IS", "アイスランド")
  ] },
  { label: "南欧", items: [
    c("IT", "イタリア"), c("ES", "スペイン"), c("PT", "ポルトガル"), c("GR", "ギリシャ"), c("MT", "マルタ"), c("CY", "キプロス"),
    c("SM", "サンマリノ"), c("VA", "バチカン"), c("AD", "アンドラ")
  ] },
  { label: "中欧・東欧", items: [
    c("PL", "ポーランド"), c("CZ", "チェコ"), c("SK", "スロバキア"), c("HU", "ハンガリー"), c("SI", "スロベニア"), c("HR", "クロアチア"),
    c("BA", "ボスニア・ヘルツェゴビナ"), c("RS", "セルビア"), c("ME", "モンテネグロ"), c("MK", "北マケドニア"), c("AL", "アルバニア"), c("XK", "コソボ"),
    c("RO", "ルーマニア"), c("BG", "ブルガリア"), c("MD", "モルドバ"), c("UA", "ウクライナ"), c("BY", "ベラルーシ"), c("RU", "ロシア"),
    c("EE", "エストニア"), c("LV", "ラトビア"), c("LT", "リトアニア")
  ] },
  { label: "北米", items: [
    c("US", "アメリカ合衆国"), c("CA", "カナダ"), c("MX", "メキシコ"), c("GL", "グリーンランド"), c("BM", "バミューダ")
  ] },
  { label: "中米・カリブ", items: [
    c("GT", "グアテマラ"), c("BZ", "ベリーズ"), c("HN", "ホンジュラス"), c("SV", "エルサルバドル"), c("NI", "ニカラグア"), c("CR", "コスタリカ"), c("PA", "パナマ"),
    c("CU", "キューバ"), c("DO", "ドミニカ共和国"), c("HT", "ハイチ"), c("JM", "ジャマイカ"), c("PR", "プエルトリコ"), c("TT", "トリニダード・トバゴ"),
    c("BS", "バハマ"), c("BB", "バルバドス")
  ] },
  { label: "南米", items: [
    c("BR", "ブラジル"), c("AR", "アルゼンチン"), c("CL", "チリ"), c("CO", "コロンビア"), c("PE", "ペルー"), c("VE", "ベネズエラ"), c("EC", "エクアドル"),
    c("BO", "ボリビア"), c("PY", "パラグアイ"), c("UY", "ウルグアイ"), c("GY", "ガイアナ"), c("SR", "スリナム")
  ] },
  { label: "オセアニア", items: [
    c("AU", "オーストラリア"), c("NZ", "ニュージーランド"), c("PG", "パプアニューギニア"), c("FJ", "フィジー"), c("SB", "ソロモン諸島"), c("VU", "バヌアツ"),
    c("WS", "サモア"), c("TO", "トンガ"), c("GU", "グアム"), c("PW", "パラオ"), c("FM", "ミクロネシア連邦"), c("MH", "マーシャル諸島"), c("KI", "キリバス"), c("NR", "ナウル"), c("TV", "ツバル")
  ] },
  { label: "北アフリカ", items: [
    c("EG", "エジプト"), c("MA", "モロッコ"), c("DZ", "アルジェリア"), c("TN", "チュニジア"), c("LY", "リビア"), c("SD", "スーダン")
  ] },
  { label: "サブサハラ・アフリカ", items: [
    c("ZA", "南アフリカ"), c("NG", "ナイジェリア"), c("KE", "ケニア"), c("ET", "エチオピア"), c("GH", "ガーナ"), c("TZ", "タンザニア"), c("UG", "ウガンダ"),
    c("RW", "ルワンダ"), c("SN", "セネガル"), c("CI", "コートジボワール"), c("CM", "カメルーン"), c("AO", "アンゴラ"), c("MZ", "モザンビーク"), c("ZM", "ザンビア"),
    c("ZW", "ジンバブエ"), c("BW", "ボツワナ"), c("NA", "ナミビア"), c("MU", "モーリシャス"), c("MG", "マダガスカル"), c("CD", "コンゴ民主共和国"), c("CG", "コンゴ共和国"),
    c("ML", "マリ"), c("BF", "ブルキナファソ"), c("NE", "ニジェール"), c("TD", "チャド"), c("SO", "ソマリア"), c("ER", "エリトリア"), c("DJ", "ジブチ"),
    c("BJ", "ベナン"), c("TG", "トーゴ"), c("GN", "ギニア"), c("SL", "シエラレオネ"), c("LR", "リベリア"), c("GA", "ガボン"), c("GQ", "赤道ギニア"),
    c("MW", "マラウイ"), c("LS", "レソト"), c("SZ", "エスワティニ"), c("SS", "南スーダン"), c("CF", "中央アフリカ"), c("MR", "モーリタニア"), c("GM", "ガンビア"),
    c("GW", "ギニアビサウ"), c("CV", "カーボベルデ"), c("ST", "サントメ・プリンシペ"), c("KM", "コモロ"), c("SC", "セーシェル"), c("BI", "ブルンジ")
  ] }
];

export const TERRITORY_GROUPS: TerritoryGroup[] = [{ label: "まとめ", items: TERRITORY_PRESETS }, ...COUNTRY_GROUPS];

export const LANGUAGE_PRESETS: CodedName[] = [c("ALL", "全言語")];

export const LANGUAGE_GROUPS: TerritoryGroup[] = [
  { label: "まとめ", items: LANGUAGE_PRESETS },
  { label: "東アジア", items: [
    c("ja", "日本語"), c("zh-Hans", "中国語（簡体字）"), c("zh-Hant", "中国語（繁体字）"), c("zh", "中国語"), c("ko", "韓国語"), c("mn", "モンゴル語")
  ] },
  { label: "東南・南アジア", items: [
    c("th", "タイ語"), c("vi", "ベトナム語"), c("id", "インドネシア語"), c("ms", "マレー語"), c("tl", "フィリピン語（タガログ語）"), c("my", "ビルマ語"), c("km", "クメール語"), c("lo", "ラオ語"),
    c("hi", "ヒンディー語"), c("bn", "ベンガル語"), c("ur", "ウルドゥー語"), c("ta", "タミル語"), c("te", "テルグ語"), c("mr", "マラーティー語"), c("gu", "グジャラート語"), c("pa", "パンジャーブ語"), c("si", "シンハラ語"), c("ne", "ネパール語")
  ] },
  { label: "欧州", items: [
    c("en", "英語"), c("fr", "フランス語"), c("de", "ドイツ語"), c("it", "イタリア語"), c("es", "スペイン語"), c("pt", "ポルトガル語"), c("pt-BR", "ポルトガル語（ブラジル）"),
    c("nl", "オランダ語"), c("sv", "スウェーデン語"), c("no", "ノルウェー語"), c("da", "デンマーク語"), c("fi", "フィンランド語"), c("is", "アイスランド語"),
    c("pl", "ポーランド語"), c("cs", "チェコ語"), c("sk", "スロバキア語"), c("hu", "ハンガリー語"), c("ro", "ルーマニア語"), c("bg", "ブルガリア語"), c("el", "ギリシャ語"),
    c("hr", "クロアチア語"), c("sr", "セルビア語"), c("sl", "スロベニア語"), c("bs", "ボスニア語"), c("mk", "マケドニア語"), c("sq", "アルバニア語"),
    c("ru", "ロシア語"), c("uk", "ウクライナ語"), c("be", "ベラルーシ語"), c("et", "エストニア語"), c("lv", "ラトビア語"), c("lt", "リトアニア語"),
    c("ca", "カタルーニャ語"), c("eu", "バスク語"), c("gl", "ガリシア語"), c("ga", "アイルランド語"), c("cy", "ウェールズ語"), c("mt", "マルタ語"), c("lb", "ルクセンブルク語")
  ] },
  { label: "中東・中央アジア", items: [
    c("tr", "トルコ語"), c("ar", "アラビア語"), c("he", "ヘブライ語"), c("fa", "ペルシア語"), c("ku", "クルド語"), c("az", "アゼルバイジャン語"), c("ka", "ジョージア語"), c("hy", "アルメニア語"),
    c("kk", "カザフ語"), c("uz", "ウズベク語"), c("ky", "キルギス語"), c("tg", "タジク語"), c("tk", "トルクメン語")
  ] },
  { label: "アフリカ", items: [
    c("sw", "スワヒリ語"), c("am", "アムハラ語"), c("ha", "ハウサ語"), c("yo", "ヨルバ語"), c("ig", "イボ語"), c("zu", "ズールー語"), c("xh", "コサ語"), c("af", "アフリカーンス語"), c("so", "ソマリ語"), c("mg", "マダガスカル語")
  ] }
];

/** 検索（名前・コードの部分一致）。q が空なら全件。選択済みは除く。 */
export function searchCodedNames(groups: TerritoryGroup[], query: string, exclude: CodedName[] = []): TerritoryGroup[] {
  const q = query.trim().toLowerCase();
  const excluded = new Set(exclude.map((e) => (e.code ?? "") + "|" + e.name));
  return groups
    .map((g) => ({
      label: g.label,
      items: g.items.filter((i) => !excluded.has((i.code ?? "") + "|" + i.name)
        && (!q || i.name.toLowerCase().includes(q) || (i.code ?? "").toLowerCase().includes(q)))
    }))
    .filter((g) => g.items.length > 0);
}

/** 旧データ（結合文字列「日本・台湾」）→ CodedName[]（マスタにあればコードを補う）。 */
export function codedNamesFromText(text: string | null | undefined, groups: TerritoryGroup[]): CodedName[] {
  const all = groups.flatMap((g) => g.items);
  return String(text ?? "").split(/[・、,\/／]/).map((s) => s.trim()).filter(Boolean)
    .map((name) => all.find((i) => i.name === name) ?? { code: null, name });
}
