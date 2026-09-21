/**
 * 決済済み一括取込の列。
 *
 * ここは何も読まない（core も imports も引かない）。取り込み・書き出し・差分の
 * どれもがこの並びを見るが、差分は画面でも使う。列の定義を service の側に
 * 置いたままだと、画面から型をひとつ借りるだけで PDF の書き出しまで
 * 引きずり込むことになる（実際に client の型検査が node:child_process を
 * 読めずに落ちた）。
 */

export const SETTLED_COLUMNS: Array<{
  key: string; label: string; required?: boolean; note: string; aliases?: string[];
}> = [
  { key: "partyCode", label: "取引先コード", note: "コードか名前のどちらかで当てる" },
  { key: "partyName", label: "取引先名", note: "登録名・別名・カナのどれかに一致" },
  { key: "workCode", label: "作品コード", note: "コードか作品名のどちらかで当てる。空なら作品なし" },
  { key: "workTitle", label: "作品名", note: "登録名に一致" },
  { key: "agreementNo", label: "契約番号",
    note: "空なら取引先から自動で当てる。「なし」と書けば基本契約なしの発注にする" },
  // 名前だけで当てると、同名の条件が2本ある取引先で取り違える。番号は
  // その1本を必ず指す。書き出しは必ず入れる（人が手で作る CSV では空でよい）。
  { key: "conditionNo", label: "条件番号", aliases: ["条件明細番号", "条件コード"],
    note: "空なら取引先・作品・条件名で当てる。書けばその条件に確実に載る" },
  { key: "conditionName", label: "条件名", note: "空なら自動。書けば同じ取引先・作品でも別の条件になる" },
  // 旧分をどうするか。条件番号を指しているときだけ効く（新しく作る行には
  // 畳む相手がいない）。画面のチェックと同じことを CSV で言えるようにする。
  // 表計算なら13人ぶんを一目で見ながら決められる。
  { key: "oldHandling", label: "旧分", aliases: ["旧分の扱い"],
    note: "残す（既定）／畳む（旧の紙・支払・実績を無効に）／無効（条件も無効に）" },
  { key: "item_name", label: "品目・業務名", required: true, note: "" },
  { key: "spec", label: "仕様・成果物", note: "" },
  { key: "quantity", label: "数量", note: "空なら 1" },
  { key: "unit_price", label: "単価（税抜）", required: true, note: "円" },
  // ここから下が遡及のための列。1枚の紙に1つの日付なので、束の中で揃える。
  { key: "orderedOn", label: "発注日", required: true,
    note: "発注書の決定日になる。束（同じ取引先・作品・条件名）の中で揃える" },
  // 納期。いつまでに納めてもらうか。納品日（実際に納まった日）とは別で、
  // 条件明細に残る（発注書の「納期」に出る）。
  { key: "deliveryDue", label: "納期", aliases: ["納入期日"],
    note: "いつまでに納めるか。空なら条件のものを引き継ぐ。納品日とは別" },
  { key: "deliveredOn", label: "納品日", required: true, note: "実績の日付。行ごとに違ってよい" },
  { key: "inspectedOn", label: "検収日", required: true,
    note: "検収書の決定日になる。束の中で揃える" },
  // 減額検収は数量で持つ。金額を直に書かせると、単価×数量と紙の合計が
  // 合わない行が作れてしまい、あとから何が起きたのか読めなくなる。
  // 紙（V2 の ordered_quantity / inspected_quantity）とも揃う。
  { key: "inspectedQuantity", label: "検収数量",
    note: "空なら 数量 と同じ。減らして納品されたらここに実際の数を書く。金額は 単価×検収数量" },
  // 減額（増額）検収は紙に「変更内容の確認」欄が出る（A-034）。その理由が
  // 空だと「（理由未記入）」と刷られて相手に出る。額が動く行では必須にする。
  { key: "varianceNote", label: "変更理由",
    note: "変更履歴付のときは必須。検収書の変更履歴にそのまま出る" },
  // 同じ「発注 12 点・検収 11 点」でも、意味が2つある。
  //   当初 12 点で発注していて、あとから 11 点に減った → 変更履歴付
  //   はじめから 11 点の取引を、いま紙にする          → 初版
  // 前者は紙に変更履歴と署名欄が出て、理由が要る。後者は変更そのものが
  // 無いので、数量に実際の数を書けばよく、理由も要らない。人にしか
  // 決められないので、行ごとに書いてもらう。
  { key: "revision", label: "版", aliases: ["変更履歴"],
    note: "初版 / 変更履歴付。空なら、検収数量が数量と違えば変更履歴付、同じなら初版" },
  { key: "dueOn", label: "支払期日", note: "空なら支払条件から出す" },
  { key: "paymentState", label: "支払状態",
    note: "未払 / 支払済み / なし。空なら未払。「なし」なら検収書まで作って支払は立てない" },
  { key: "paidOn", label: "入金日", note: "支払状態が 支払済み のときは必須" },
  { key: "contract_form", label: "契約形式", aliases: ["契約種別・支払条件"],
    note: "請負 / 委任 / 準委任 など。発注書の「契約種別」に出る" },
  { key: "payment_terms", label: "支払条件", note: "例: 月末締め翌月末払い" },
  { key: "deliverable_ownership", label: "成果物の帰属先",
    note: "発注者 か 受注者。空ならその行に帰属先を出さない" },
  { key: "orderSign", label: "発注署名欄", note: "あり / なし。空なら なし" },
  { key: "acceptSign", label: "承諾署名欄", note: "あり / なし。空なら なし" },
  // 特約は毎回同じ文面を貼ることが多いので、定型文の名前でも呼べるようにする。
  { key: "specialTermsSnippet", label: "特約の定型文",
    note: "定型文（特約）の名前。全行に長文を貼らずに済む" },
  { key: "specialTerms", label: "特約",
    note: "本文を直接書く。定型文と両方あれば、定型文のあとに続けて入る" },
  { key: "remarks", label: "備考", note: "" }
];

/** 見出しの揺れ（別名・鍵そのもの）を吸って値を取る。取り込みと差分で同じ読み方をする。 */
export const pick = (
  row: Record<string, string>, column: { key: string; label: string; aliases?: string[] }
) => {
  const hit = row[column.label] ?? row[column.key];
  if (hit !== undefined) return hit;
  for (const alias of column.aliases ?? []) if (row[alias] !== undefined) return row[alias];
  return "";
};
