# 利用許諾の基本契約・個別条件書 V5

出版とボードゲームの基本契約を、共通の **著作物利用許諾基本契約書V5** にまとめた。
事業ごとに違う条項（出版権・原稿、ボードゲーム化・素材など）は基本契約に置かず、
**個別利用許諾条件書V5** に「事業別条項」として置く（基本契約V5 第3条第5項）。

## ひな形

| キー | 名前 | 本文 | 採番 | 差し込み |
|---|---|---|---|---|
| `license_master_v5` | 著作物利用許諾基本契約書V5 | `infra/v3/templates/license_master_v5.html` | LIC | `documents/license-master-v5.ts` |
| `individual_license_terms_v5` | 個別利用許諾条件書V5（ボードゲーム） | `infra/v3/templates/individual_license_terms_v5.html` | ILT | `licenseTermsPatch`（V4 と同じ） |
| `pub_license_terms_v5` | 個別利用許諾条件書V5（出版・一覧形式） | `infra/v3/templates/pub_license_terms_v5.html` | PUBT | `pubTermsPatch`（V3 と同じ） |
| `pub_license_terms_v5_annex` | 個別利用許諾条件書V5（出版・別紙形式） | `infra/v3/templates/pub_license_terms_v5_annex.html` | PUBT | `pubTermsPatch`（V3 と同じ） |

- 条件書V5 の体裁はボードゲームの V4 と同じ（出版も同じ CSS）。
  - ボードゲーム：01〜03 は V4 のまま、**04 ボードゲームに関する定め**、05 通知先、別紙1〜3。
  - 出版・一覧形式（作品が少ないとき）：01 に一覧、**07 出版に関する定め**、09 特記事項、10 通知先。別紙なし。
  - 出版・別紙形式（作品が多いとき）：01 は点数の要約、**07 出版に関する定め**、09 通知先、別紙1 特記事項、別紙2 一覧。
- 既存のひな形（`license_master`・`pub_master_*`・`individual_license_terms_v3/v4`・`pub_license_terms_v3/_annex/_multi`）と
  その版の文書には触れていない。旧基本契約の相手先は従来の条件書で続ける。

## 版の組み合わせ

V5 の条件書は基本契約V5 の条（第3条第5項など）を指すので、**基本契約V5 の下だけ**で使う。

- 文書の画面：条件書を作るとき、基本契約の版と合わないと警告を出す（`termsVersionWarnings`。発行は止めない）。
  - V5 の条件書で、基本契約が無い／基本契約が V5 でない
  - 旧版の条件書で、基本契約が V5
- 作業テーブル（IN）：基本契約は V5。相手先に有効な基本契約があるのに V5 の文書が無ければ、条件書の既定を旧版にする（`orderMainDocs`）。
  OUT は当社が許諾者になるので従来の利用許諾基本契約書のまま。
- 契約なしからの一括作成（`missing-contracts.ts`）：基本契約が無ければ V5 を作り、条件書も V5。
  既存の基本契約が V5 の文書なら V5、旧基本契約なら V3。
- 基本契約が V5 かどうかは、契約に載っている基本契約書の文書のひな形で見る（`license_master_v5` の文書があるか）。
- 旧基本契約の相手先を V5 に移すときは、契約の「巻き直し」で「著作物利用許諾基本契約書V5」を選ぶ。

## デプロイ

1. アプリを先に出す（V5 のキーを扱う版）。出ていないと、V5 のひな形の入力欄が空で出る。
2. `infra/v3/212_v5_license_templates.sql` を流す（Cloud SQL Studio に貼る／ローカルは
   `docker compose run --rm ops sql /v3/212_v5_license_templates.sql`）。何度流しても同じ。
3. 確認：文書の作成で 4 本が選べること、基本契約V5 → 条件書V5 の順で作って警告が出ないこと。

止めるとき（旧版に戻す。V5 で作った文書は開ける）：

```sql
UPDATE v3.document_templates SET is_active = false
 WHERE template_key IN ('license_master_v5', 'individual_license_terms_v5', 'pub_license_terms_v5', 'pub_license_terms_v5_annex');
```

本文を直したら `node infra/v3/tools/make-template-sql.mjs` で 212 を作り直す（`--check` で食い違いを確かめられる）。
