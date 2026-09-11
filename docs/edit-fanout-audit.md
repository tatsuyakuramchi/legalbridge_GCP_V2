# 編集が効かない理由の構造分析（情報散在と書込ファンアウト）

指摘：「テーブル構造のせいで情報が散乱しており、結果としてUIの編集機能が役に立たない」。

本書はこれを **UIの問題ではなく書込ファンアウト（write fan-out）の問題**として裏取りした結果。
`docs/display-edit-gap-audit.md` が「編集手段が無い／入力欄が無い」を潰したのに対し、
本書は「**編集手段はあるのに反映されない**」を対象にする。

---

## 1. 結論

1つの業務事実が **N箇所に保存**され、**M本の編集経路がそれぞれ違う部分集合しか更新しない**。
したがって「どこで直しても、どこかには効かない」が構造的に起きる。UIを足しても解消しない。

- 例：**文書の件名**は `documents.contract_title` を **6モジュールが読む**が、
  **作成後にこの列を UPDATE する経路が1つも存在しない**（再発行のみ）。
  UIの「表示情報の修正」は `form_data.title` しか書かないので、直しても大半の画面は古い値のまま。
- 例：**条件明細の金額・料率・期間・条件名を UPDATE する SQL は全コードに1つも無い**。
  条件明細への UPDATE は4本あるが、書く列は「親条件ID」「リンク列」「相手方」「文書ID付替」のみ。

---

## 2. 症状の機序

```
        1つの業務事実（例：相手先）
                 │
   ┌─────────────┼─────────────┬──────────────┬───────────────┐
   ▼             ▼             ▼              ▼               ▼
documents      documents    condition_lines  contracts      matters
.vendor_id     .form_data   .counterparty_   .primary_       .counterparty
.vendor_name_  （10種の      vendor_id        vendor_id       .vendor_id
 snapshot       キー名）
   ▲             ▲             ▲              ▲               ▲
   │             │             │              │               │
   └── import-   └── display-  └── PATCH      └── 条件台帳     └── PATCH
       details       fields        /counter-      保存           /matters/:id
   （form_data   （form_data       party
     +vendor_id）  のみ）        （1列のみ）
```

**どの編集経路も、他の保存先を更新しない。**

---

## 3. 事実ごとの散在マトリクス（実測）

### 3.1 相手先（取引先）

| 保存先 | 誰が読むか | 更新する編集経路 |
|---|---|---|
| `documents.vendor_id` | 経理エクセル（取引先コード・カナ・源泉判定）、宛先候補、期限一覧 | `PUT /documents/:id/import-details`（取込文書のみ） |
| `documents.vendor_name_snapshot` | マスタ検索、フォーム文脈、期限一覧 | **無し**（作成時のみ） |
| `documents.form_data`（**10種のキー**） | 一覧・検索・PDF本文・引用 | `display-fields`（`counterparty` 1キーのみ）／`import-details`（全体） |
| `condition_lines.counterparty_vendor_id` | 条件一覧・詳細、請求、債権マップ | `PATCH /condition-lines/:id/counterparty` |
| `contracts.primary_vendor_id` | 契約マスタ、期限、案件 | 条件台帳保存 |
| `contract_works.rights_holder_vendor_id` | 作品権利 | 契約取込時のみ |
| `matters.counterparty` / `matters.vendor_id` | 案件一覧・Slack | `PATCH /matters/:id` |
| `payments.counterparty_vendor_id` | 支払 | 支払登録時 |
| `vendors.vendor_name`（マスタ） | 全画面のJOIN | `PATCH /vendors/:id` |

`form_data` 側の相手先キーは **`VENDOR_NAME` / `Licensor_氏名会社名` / `Licensor_名称` / `許諾者` /
`相手先` / `取引先` / `counterparty` / `LICENSOR_NAME` / `licensor` / `designerName` / `PARTY_A_NAME`**。

### 3.2 件名・契約名

| 保存先 | 読み手 | 更新経路 |
|---|---|---|
| `documents.contract_title` | **6モジュール**（日次ジョブ／条件添付／案件／契約チェック／依頼／期限） | **無し**（INSERT のみ） |
| `documents.form_data`（6キー） | 一覧・検索・PDF | `display-fields`（`title`）／`import-details` |
| `contracts.contract_title` | 契約マスタ・期限・案件 | 条件台帳保存（`ledger-repository.ts:282`） |
| `royalty_statement_lines.contract_title` | 計算書明細 | 計算書確定時 upsert |
| `matters.title` | 案件 | `PATCH /matters/:id` |

### 3.3 金額・料率・期間・地域言語（条件明細）

`condition_lines` への **UPDATE は4本のみ**で、いずれも金額系を書かない。

| 経路 | 書く列 |
|---|---|
| `ledgers/outbound-condition-repository.ts:255` | `parent_license_condition_id` のみ |
| `conditions/attachment-repository.ts:406` | リンク列のみ（`document_id`, `work_id`, `source_*`, `counterparty_vendor_id`, `flow_direction`） |
| `conditions/repository.ts:297` | `counterparty_vendor_id` のみ |
| `documents/condition-sync-repository.ts:241` | `document_id` / `capability_id`（再発行の付替） |

**`amount_ex_tax` / `rate_pct` / `mg_amount` / `ag_amount` / `term_start` / `term_end` /
`condition_name` を変更する手段は「文書を作り直して置換 upsert する」以外に存在しない。**

地域・言語は5経路が別々に INSERT し、うち1本（`attachment-repository.ts:435`）だけが
DELETE→INSERT で置換する。テキスト列 `region_territory` / `region_language` は別系統。

---

## 4. 確認された具体的な破れ

| # | 事象 | 根拠 |
|---|---|---|
| 1 | **「表示情報の修正」で相手先を直しても文書一覧の検索でヒットしない**。表示解決は `counterparty` キーを読む（`registry-repository.ts:224-227`）が、一覧の検索 WHERE は `PROJECT_TITLE / CONTRACT_TITLE / 基本契約名 / VENDOR_NAME / Licensor_氏名会社名` の5キーしか見ない（同 `:96`）。修正で書くキー（`title` / `counterparty`）はどちらも検索対象外 | `import-repository.ts:168` / `registry-repository.ts:96,221-227` |
| 2 | **件名を直しても契約チェック・期限・案件・日次ジョブの表示は変わらない**。これらは `documents.contract_title` を読むが、UPDATE 経路が存在しない | 読み手6モジュール（`daily-checks-repository.ts:79` / `attachment-repository.ts:92` / `matters/repository.ts:137` / `contract-check/repository.ts:85,100` / `requests/repository.ts:268` / `deadlines/repository.ts:282`）。`SET contract_title` は `contracts` と `royalty_statement_lines` にしか無い |
| 3 | **取込文書の詳細編集が業務列を更新しない**。`form_data` と `vendor_id` だけを書き換え、`contract_title` / `contract_status` / `effective_date` / `expiration_date` / `record_type` は作成時の値のまま | `import-repository.ts:153-166` |
| 4 | **条件添付の編集が既存値を黙って無視する**。`COALESCE(work_id, $4)` 形式のため、既に値が入っている行は新しい値で上書きされない。UI は成功として表示する | `attachment-repository.ts:406-420` |
| 5 | **同じ事実の解決キー配列が4本、それぞれ内容が違う**。`document-business-columns.ts`（相手先10・件名6）／`registry-repository.ts` 表示（相手先6・件名5）／同 検索（5）／`document-html-renderer.ts` ／ `excel-batch-engine.ts`。どのキーで保存されたかで、表示・検索・PDF・エクセルの見え方がバラバラになる | 4つの `firstText`/`firstNonEmpty` 実装 |
| 6 | **取引先マスタの改名が文書に伝播しない**。`documents.vendor_name_snapshot` を更新する経路が無く、読み手によって「マスタ優先」（期限一覧）と「スナップショット優先」（マスタ検索）が混在 | `master-data/repository.ts:106,113` vs `deadlines/repository.ts:290` |

---

## 5. なぜ「UIを直す」では解決しないか

第1〜3波の監査（`display-edit-gap-audit.md`）は「入力欄が無い」を潰した。
本書の対象はその次の層で、**入力欄はあるが書込先が足りない**。UIに欄を足すほど
「直したのに反映されない」が増えるため、**UI追加は症状を悪化させる方向に働く**。

分岐点は次のとおり。

- 入力欄が無い → UI追加で解決（第1〜3波で対応済み）
- 入力欄はあるが書込先が部分的 → **書込層の再設計が必要（本書）**

---

## 6. 対処（既存テーブル構造を変えずに実施できる）

### A. 用語辞書の一元化【前提・小】

`form_data` のキー解決を**1モジュールに集約**する。現在4本ある `firstText` 系を廃し、
`業務事実 → キー候補列` の単一の辞書を作って、表示・検索・PDF・エクセル・業務列導出の
すべてがそれを参照する。**まず #1 と #5 が消える。**

### B. 書込ファンアウトの一元化【本丸・中】

「相手先を変更する」「件名を変更する」を**業務事実単位のサービス関数**にし、
関係する保存先を **1トランザクションで全部更新**する。

```
changeCounterparty(documentId, vendorId)
  → documents.vendor_id
  → documents.vendor_name_snapshot
  → documents.form_data の正規キー（辞書A経由）
  → その文書に紐づく condition_lines.counterparty_vendor_id
  → 紐づく contracts.primary_vendor_id
  （更新した保存先を応答に列挙して UI に出す）
```

現在の `PATCH /condition-lines/:id/counterparty` のような**列単位API**は、
この事実単位APIの内部実装に降格させる。GRANT は既存のものでほぼ足りる
（`condition_lines` は 066、`documents` は 064、`contracts` は条件台帳の既存権限）。

### C. 条件明細の正式な編集経路【中】

金額・料率・期間・条件名の UPDATE を新設する。実績（`condition_events`）を持つ行は
**改訂履歴を残す形**（現行の再発行と同じ思想）にし、実績の無い行は直接更新でよい。
これが無い限り「条件を直せない」は残り続ける。

### D. 効かない編集を正直に出す【小・即効】

- #4 の `COALESCE` 黙殺をやめ、既存値と異なる値が来たら **409＋現在値**を返す。
- 更新できなかった保存先を応答に含め、UIに「この修正はPDF本文には反映されません」等を明示する。
- 「表示情報の修正」は名前どおり表示専用であることを画面に出す（現状はコメントにしか無い）。

**Dだけでも体感は大きく変わる**。「直したつもりが直っていない」が「直せないと分かる」になる。

### E. 不整合の可視化【小】

`data_quality_issues` に整合ルールを追加する。
`documents.contract_title` と `form_data` の件名が食い違う行、
`documents.vendor_id` と `condition_lines.counterparty_vendor_id` が食い違う行、
`vendor_name_snapshot` がマスタと違う行。**現状は誰も気づけない。**

---

## 7. 優先順位

| 順 | 施策 | 規模 | 効果 |
|---|---|---|---|
| 1 | D. 効かない編集を正直に出す | 小 | 誤解の即時解消 |
| 2 | A. 用語辞書の一元化 | 小〜中 | #1・#5 の根絶 |
| 3 | B. 書込ファンアウトの一元化（相手先・件名から） | 中 | #2・#3・#6 の根絶 |
| 4 | E. 不整合の可視化 | 小 | 既存データの負債を計測可能に |
| 5 | C. 条件明細の正式な編集経路 | 中 | 「条件を直せない」の解消 |

いずれも **DDL不要**（既存テーブル構造の変更なし）で、追加GRANTもほぼ不要。

---

## 8. 補足：構造そのものへの評価

テーブル構造が原因という見立ては正しいが、正確には
**「構造が悪い」より「構造の冗長性に書込側が追随していない」**。
`documents` と `contracts` と `condition_lines` に同じ事実が載る設計は
V1からの互換境界として動かせないので、**冗長性を前提に、書込を1点に集約する**のが唯一の解になる。
読取側は既にフォールバック（`COALESCE`）で冗長性を吸収できているのに、
書込側だけが経路ごとにバラバラなまま増えたことが、今の状態の直接の原因である。
