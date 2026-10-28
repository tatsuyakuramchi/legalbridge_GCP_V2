# 条件明細の持ち主を正す（段階2の設計メモ）

状態：§7 を決めて合意済み（2026-10-28）。段階1（表現の整理）は PR #324、PR-A（読み出しの統一）は PR #325 で入れた。PR-B はこのブランチ。

## 1. いま何がずれているか

業務のルール：

- 取引先は種別（業務委託／ライセンス）× 方向ごとに基本契約を何本も持つ。
- 条件明細を持つのは個別契約（条件書・発注書）か単体契約。基本契約は条件明細ではなく個別契約を持つ。

システムの作り（`conditions.agreement_id` の指す先）：

| 取引の形 | いまの指す先 | ルール上の持ち主 |
|---|---|---|
| ライセンス：基本契約の下の条件書（`kind=supplement` の行がある） | 基本契約 | 条件書（個別契約） |
| 業務委託：基本契約の下の発注書（文書。契約の行は無い） | 基本契約 | 発注書（個別契約） |
| 単体契約（`kind=standalone`） | 単体契約 | 単体契約 |
| 基本契約の無い発注書（発注書の約款で取引） | NULL | 発注書 |

段階1で画面の言い方は直したが、データは「条件は基本契約の明細」のまま。
文書の契約番号・基本契約名は `条件 → agreement_id` を基本契約とみなして出している所が多く、
データだけ直すと個別契約の番号が基本契約として印字される。

## 2. 目指す形

- `conditions.agreement_id` は 個別契約（`supplement`）か 単体契約（`standalone`）だけを指す。基本契約（`master`）は指さない。
- 基本契約は `agreements.parent_id` で辿る。「この条件の基本契約」は 1 か所の関数で求める（既にある `conditions/contracts.ts` の `conditionContracts` が親を辿っている。これに寄せる）。
- 発注書も個別契約の行を持つ。発注書を決定したとき、条件書と同じ仕組み（`agreements/auto.ts` の `ensureAgreementForTerms`）で `kind=supplement`・親＝基本契約・番号＝発注書の番号 の行を立て、条件はそこを指す。発注書の文書（`documents.agreement_id`）もその行に繋ぐ。
  - 画面では発注書として見せる（契約の一覧には出さない。取引先⇔基本契約の図ではいまの「発注書」の行のまま）。
  - 過去に「PO 番号の単体契約を文書に寄せる」（`order_as_agreement` のずれ）と決めたのは、親の無い `standalone`／`document` を契約として並べていたから。今度は親付きの `supplement` で、発注書であることを `agreements` に印（`order_document_id`）で持つ。ずれの判定は `standalone`／`document` だけなので矛盾しない。
- 基本契約の無い発注書（発注書の約款で取引）も、決定したとき `kind=standalone`・番号＝発注書の番号 の行を立て、条件はそこを指す（`v3-tidy.md` の型 2「基本契約の無い発注書も 1 取引（独立契約）」のとおり）。あとで基本契約を結んだら「個別契約にする」で親を付けるだけで済む。

採らなかった案：発注書は文書のままにし、`documents.agreement_id` を基本契約にして条件は NULL。
行は増えないが、「この条件の契約」を求めるのに毎回 文書 を経由することになり、条件の画面・CSV・計算書で「契約なし」と「基本契約の下の発注書」が区別できない。

## 3. 変える所

### 3.1 書き込み（条件を基本契約に載せている所）

| 場所 | いま | 変更 |
|---|---|---|
| `agreements/auto.ts` `ensureAgreementForTerms` | 条件書が `supplement` のとき条件は基本契約のまま | 条件を立てた `supplement` に向ける。発注書の決定でも呼ぶ |
| `agreements/party-map.ts` `agreementFromDocument` | 個別契約を立てても条件は親（基本契約）へ | 立てた個別契約へ |
| 同 `demoteToIndividual` / `promoteToStandalone` | 条件を基本契約へ移す／基本契約から戻す | 条件は動かさない（親を付ける／外すだけ）。戻すときの「基本契約に載っている条件のうち文書に載るもの」の探索が不要になる |
| 同 `linkOrder` / `orderUnderMaster` / `orderAgreementToDocument` | 発注書の条件を基本契約へ | 発注書の個別契約の行を立てて（無ければ）そこへ |
| `documents/document-set.ts` | 選んだ条件を基本契約へ | 条件書・発注書の個別契約へ |
| `imports/existing-contracts.ts` | 条件を基本契約へ、条件書の文書は基本契約に繋ぐ | 条件書の `supplement` を立て、条件・文書をそこへ |
| `documents/batch-service.ts`（CSV 一括発注） | `agreementId = basicAgreement()`（基本契約） | 発注書の決定で個別契約を立てて向け直す（登録時は基本契約を「親の候補」として持つだけ） |
| `conditions/write-service.ts`（束・ライセンスセット） | `input.agreementId` を種類を見ずに入れる | 基本契約を渡されたら「親」として受け、条件書・発注書の決定で個別契約へ向ける。それまでの間は基本契約を指す＝「まだ個別契約の無い条件」として許す（§4） |
| `links/relations.ts`（条件⇔契約の付け外し） | どの種類にも付けられる | 基本契約には付けない（個別契約・単体契約だけ） |
| `imports/service.ts`・`imports/pub-works.ts`（CSV 取込の 契約番号） | 契約番号の契約をそのまま | 基本契約の番号なら親として扱い、条件書の決定で個別契約へ |
| `agreements/master-merge.ts` | 基本契約 A の条件を B へ | 条件は個別契約に付いているので、個別契約の親を付け替えるだけ |

### 3.2 読み出し（条件の契約を基本契約とみなしている所）

親を辿っている（そのままでよい）：`conditions/contracts.ts`、`royalty/in-contract.ts`、`documents/context-repository.ts` の `masterAgreementOf`、`documents/cite-no.ts`。

直接読んでいる（直す。直さないと個別契約の番号が基本契約として出る）：

| 場所 | 出る所 |
|---|---|
| `documents/context-repository.ts` :924 :952（`la`）、`template-context.ts` :1140-1144 :1226 | 発注書の「■ 利用許諾条件」の個別契約の文、`royalty-in-lieu` の基本契約 |
| `documents/legacy-variables.ts` :163、`pub-terms.ts` :533-546 | 契約締結日、自動更新、終了通知期限（基本契約の値を出すべき） |
| `royalty/statement-service.ts` :221 :828、`royalty/ledger-service.ts` :465-471 :574 | 計算書の契約番号・件名 |
| `agreements/party-map.ts` :630-638（発注書の `masterId`）、:442-445（`LOOSE_CONDITION_WHERE`） | 取引先⇔基本契約の図 |
| `documents/missing-contracts.ts`、`documents/batch-service.ts` :758-765 :810 | 契約チェック、一括作成の表示 |
| `conditions/repository.ts`、`conditions/export.ts`、`exports/repository.ts`、`documents/settled-export.ts` | 条件の詳細・CSV（「契約」の列に個別契約が出るのは正しい。「基本契約」の列を別に足す） |

やり方：`conditionContracts` の `master`／`individual` を使う 1 本の関数に寄せ、直接 `c.agreement_id` を基本契約として読む所を無くす。
**この直しはデータを変える前に入れる**。親を辿る関数は、条件が基本契約を指していても（親なし＝自分）、個別契約を指していても同じ答えを返すので、移行の前後どちらの形でも動く。

### 3.3 画面

- 条件の登録フォーム（`ConditionCreateForm`・`LicenseSetForm`・`PubConditionSetForm`・`ServiceLinesForm`・`OutConditionForm`）：「基本契約（合意）」の欄はそのまま。意味は「この条件が入る個別契約の親」。基本契約が複数ある相手では選ばせる（いまの動き）。
- 条件の画面「契約」の欄（`ConditionContracts`）：個別契約と基本契約を分けて出す。付け替えは個別契約の親を変える。
- 取引先⇔基本契約：発注書の行は `supplement` の行から出す（文書の条件から推定しない）。「個別契約にする／単体契約に戻す」は条件を動かさない旨に文言を直す。
- 整理する（`TidyFlow`・`tidy.ts`）：木の「個別契約（条件書・発注書）」の段に発注書の行が揃う。

## 4. 途中の状態を許す

条件を登録してから条件書・発注書を決定するまでの間、条件はまだ個別契約を持たない。この間は `agreement_id` に基本契約を入れたままにし、「個別契約待ち」として扱う（取引先⇔基本契約では「持ち主の決まっていない条件明細」に出る。いまの `master_holds_conditions` と同じ）。
決定のときに個別契約の行を立てて向け直す。つまり「基本契約を指す条件」は **移行後も一時的には存在する** が、決定済みの文書に載っている条件が基本契約を指すことは無くなる。

## 5. 移行（`infra/v3/190_condition_holder.sql`）

列の追加は `infra/v3/189_order_agreements.sql`（`agreements.order_document_id`。PR-B で先に流す）。データの移し替えは 190（PR-C）。

1. 退避：`CREATE TABLE conditions_agreement_backup_189 AS SELECT id, agreement_id FROM conditions`（戻せるように）。
2. ライセンス：基本契約を指す条件のうち、`supplement` の行に繋がった条件書（`documents.agreement_id = supplement` かつ `document_conditions`）に載っているもの → `agreement_id = その supplement`。
3. 業務委託：基本契約を指す条件のうち、発注書の文書（`ORDER_DOCUMENT_SQL`）に載っているもの → 発注書ごとに `supplement` の行を立て（番号＝発注書の本体番号。既に契約の番号として使われていれば `基本契約番号-Snn`。親＝その基本契約、`order_document_id`＝発注書）、条件と文書をそこへ。
   - 1 枚の発注書の条件が 2 本の基本契約に割れているものは移さず、一覧に出す（人が決める）。
4. 基本契約の無い発注書：条件が NULL で発注書の文書に載っているもの → 発注書ごとに `standalone` の行を立て（番号＝発注書の本体番号、`order_document_id`＝発注書）、条件と文書をそこへ。
5. 残り（基本契約を指し、どの文書にも載らない）：そのまま（§4 の「個別契約待ち」。画面のずれに出る）。
6. 検証：移行の前後で、決定済み文書ごとに 契約番号・基本契約番号・基本契約名・締結日・自動更新・通知期限 を `template-context` で計算して突き合わせる（差が 0 件であること）。計算書の契約番号（`in-contract.ts`）も同じ。
7. 件数の突合：`conditions` の `agreement_id` が `master` を指す行数が、§4 の個別契約待ちだけになっていること。

ローカル DB で乾式 → 本番のバックアップ → 本番。

## 6. PR の分け方

| 順 | 内容 | データ |
|---|---|---|
| A | 読み出しを「親を辿る 1 本の関数」に統一（§3.2）＋テスト | 変えない。入れた時点で何も変わらないことを §5-5 の突合で確かめる |
| B | 発注書の決定で個別契約の行を立てる（`agreements/order-agreement.ts`）。書き込みを新ルールに（§3.1）。画面（§3.3） | 新しく作る分だけ新ルール。古い分は読み出しが親を辿るので壊れない。**先に 189 を流す** |
| C | 移行 SQL（§5）＋検証クエリ | 既存の分を新ルールへ |

A と B の間、B と C の間は、それぞれ本番で様子を見てから進める。

## 7. 決めたこと（2026-10-28）

1. 発注書の個別契約の番号は発注書の番号（例 `ARC-PO-2026-0098`）。訂正版（`-R2`）は本体番号にそろえる（条件書と同じ）。
2. 基本契約の無い発注書は `standalone`（単体契約）の行を立てる（段階2に含める）。
3. 1 枚の発注書の条件が 2 本の基本契約に割れているもの（§5-3）は、移行で触らず一覧に出して人が決める。
4. 条件の CSV・一覧の「契約」の列は個別契約の番号。「基本契約」の列を別に足す。
