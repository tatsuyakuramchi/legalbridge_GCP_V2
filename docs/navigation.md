# 左のメニュー（入口の組み直し）

対象: `apps/legalbridge-v3`（`src/client/nav.ts`・`App.tsx`）

## 1. 区分

| 区分 | 項目 | 束ねる画面（view。運用はタブ） |
|---|---|---|
| — | ホーム | home |
| 格納情報の登録・編集 | 取引先 | parties |
| | 作品 | works |
| | 契約 | agreements ／ agreement-map（取引先⇔基本契約） |
| | 条件明細 | conditions |
| | 文書 | documents |
| 作業 | 受付 | intake（受付箱）／ daily（デイリータスク） |
| | 取引開始作業 | workbench |
| | 支払処理作業 | paydocs（支払文書）／ deals（入金・取引管理）／ rounds（入金と作者への支払）／ closing（まとめて締める）／ money（支払・お金） |
| 一括処理 | まとめて登録・更新する | ops/imports |
| | まとめて作る・送る | workbench（一括：発注書 CSV）／ ops/contracts ／ closing ／ ops/sending |
| | まとめて直す・整理する | ops/fixes ／ workbench（一括：検収済みの遡及） |
| | 書き出す | ops/exports |
| マネージメント | 案件 | matters |
| | 稟議 | ringi |
| 監査 | 点検・取り残し | ops/quality ／ drift |
| | フロー監視・期限 | flows ／ ops/deadlines |
| | 関連当事者 | rpt |
| | 監査レポート・記録 | ops/audit-report ／ ops/audit |
| — | 設定 | ops/snippets ／ statement-models ／ integrations ／ leftovers ／ settings（admin だけ） |

## 2. 決まりごと

- **画面と URL は変えない。** 項目は今ある画面を束ねるだけ。ほかの画面からの飛び先（`setView`）・古いブックマーク・ホームの札はそのまま動く。
- 項目が 2 つ以上の画面を束ねるときは、画面の上にその切り替え（タブ）を出す。運用（ops）の画面は運用のタブを出さず、見出しを項目の名前にする。
- **光らせる項目** は開いている画面から決める（`activeHub`）。sub（運用のタブ・作業テーブルの一括のモード）まで当たる項目が先、同じ画面が 2 つの項目にあれば最後に押した方、どちらでもなければ先に並ぶ方（まとめて締める → 支払処理作業）。
- 受付の件数（受付箱の未処理・更新あり／デイリータスクの残り）は「受付」に出す。

## 3. このあと

- 支払処理作業の中身の片寄せ（回号・イベント式／時限式の印、取引管理の入金パネル、「入金と作者への支払」を取り込んで rounds をやめる、売上の取込のタブ）。
- 一括処理 › まとめて登録・更新する に、条件明細・作品・取引先⇔基本契約に散っている CSV 取込を寄せる。
- 作品の「権利とお金の流れ」タブ、監査 › 条件の点検。
