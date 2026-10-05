# V3 契約の当事者（三社間契約）— A-068

## 背景

V3 の契約（`v3.agreements`）の相手方は `counterparty_id` の 1 列だけで、
当社（アークライト）対 相手方が 1 対 N になる三社間契約を表せなかった。
「相手方を 1 社だけ選ぶ」か「同じ契約を 2 本登録する」しかなく、
もう 1 社は横断検索・取引先の画面・法務検索の「有効な基本契約があります」判定のどれにも出なかった。
契約を 2 本に分けると、番号の一意制約・`duplicate_master` の「ずれ」・期限と更新通告の二重発生が起きる。

## 方針（案A）

- **主たる相手先は `agreements.counterparty_id` のまま。** 番号・条件の向き・既存の画面を壊さない。
- **他の当事者だけを `v3.agreement_parties` に持つ。** 1 行＝1 社。立場（`role`）と頭書きの順（`seq`、丙＝2 から）。
- **読むときは `v3.v_agreement_parties`。** 主たる相手先（seq 1・`is_primary`）と他の当事者を 1 本に並べたビュー。
  「この取引先の契約」を引く画面はすべてここを通す（統合は `v_party_resolved` で辿る）。
- **文書は変えない。** 文書は合意（`agreement_id`）経由で N 社に繋がる。「文書は相手先を持たない」という V3 の方針を保つ。
- **条件明細・支払の相手先は 1 社のまま。** 金銭の向きは必ず 2 者間で決まるので、三社間契約でも支払先は条件ごとに 1 社で正しい。

```
agreements.counterparty_id  … 乙（主たる相手先）
agreement_parties           … 丙・丁 …（role: co_party / agent / guarantor / rights_holder / other）
v_agreement_parties         … 乙＋丙・丁 … を 1 本に（取引先→契約の逆引き用）
```

## DB

- `infra/v3/159_agreement_parties.sql`（本番用 ops SQL）／ `004_amend.sql` の A-068（同じ内容）
- 制約：`UNIQUE (agreement_id, party_id)`、`UNIQUE (agreement_id, seq) DEFERRABLE`（順の入れ替えを同一トランザクションで）
- 主たる相手先をこの表に重ねて入れないことはアプリで断る（ビューは `party_id <> counterparty_id` で畳む）
- トリガは使わない。バックフィルも要らない（既存の 2 者間契約は行を持たない＝そのまま）

## サーバー

| 場所 | 変更 |
|---|---|
| `agreements/parties.ts` | `AgreementPartyService`（足す・立場／順を直す・外す・主たる相手先と入れ替える）。`AGREEMENT_HAS_PARTY` / `AGREEMENT_HAS_RESOLVED` の SQL 断片 |
| `agreements/service.ts` | `AgreementRow.parties`。一覧の取引先絞り込みを当事者集合に。登録で `parties[]` を受ける。解除合意に親の当事者を写す |
| `agreements/party-map.ts` | 図は「当事者として入っている契約」を引く。`parent_party_mismatch` と `planRemap` は親の当事者集合で判定。付け替えで相手先を他の当事者にすると席を入れ替える |
| `links/relations.ts` | 契約⇔条件明細の候補を当事者集合で絞る。契約の「当事者」、取引先の「契約」を当事者集合で出す |
| `search/legal-search.ts` / `monitoring/contract-check.ts` | 法務検索・契約チェックが丙として入っている契約・文書も拾う |
| `parties/repository.ts` | 取引先詳細の「合意」件数を当事者集合で数える |
| `documents/repository.ts` | 文書一覧の検索語を他の当事者の名前にも当てる |
| `documents/context-repository.ts` | ひな形の文脈に `agreement.parties[]`（丙 …）と `agreement.partyCount` |

API：`GET/POST /agreements/:id/parties`、`PATCH/DELETE /agreements/:id/parties/:partyId`、
`POST /agreements/:id/parties/:partyId/make-primary`。`POST /agreements` は `parties[]` を受ける。

## 画面

- 契約の画面：当事者のパネル（足す・立場・順・外す・主たる相手先にする）。登録フォームに「他の当事者」の行。
- 取引先⇔基本契約：この取引先が丙として入っている契約も図に出す（「主たる相手先：◯◯」の印）。各契約に「当事者」の欄。
- 取引先の画面：「合意」の件数と「契約（合意）」の関連が、丙としての契約も含む。

## 文書の作り方（運用）

三社間契約の契約書はひな形で作らず、テンプレート外のワンオフ文書として作る。
できた紙（PDF など）は、取引先⇔基本契約の各契約の「文書」から取り込んで契約に繋ぐ
（`documents.agreement_id`）。文書は合意経由で全当事者に繋がるので、文書側に当事者の列は要らない。

- 文書一覧・取引先の画面・法務検索は、契約の当事者集合を辿るので、丙の側からもその文書が見える。
- 文書の表示上の相手先（`v_document_display.counterparty`）は主たる相手先（乙）のまま。
- ひな形の文脈には `agreement.parties[]` / `agreement.partyCount` を渡しているが、
  三社間の頭書きを出すひな形は作らない（将来ひな形化するときの入口として残すだけ）。
