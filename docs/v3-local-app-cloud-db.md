# 設計メモ：アプリを手元に置き、DB は平時 Cloud SQL・停止時はローカルの写しへ切り替える

2026-11-08 時点の構想。まだ決めごとであって、実装は「経路の確認（`ops netcheck`）」から始めている。
進んだら、この文書の「いまの状態」を更新する。

## ねらい

| 局面 | アプリ | DB | 外（Slack・依頼者・定期実行） |
|---|---|---|---|
| 平時 | **手元の PC**（`infra/local` の app） | **Cloud SQL**（トンネル越し） | 公開 URL（Cloudflare Tunnel か既存の口 `legalbridge-v3-gateway`）→ 手元の app |
| GCP 停止中 | 手元のまま | **ローカルの写しへ切り替え**。`READ_ONLY=false`、変更を記録 | Cloud Run の口・Scheduler は止まる。Cloudflare 側に置けば続く |
| 復旧後 | 手元のまま | 書いた分を本番へ戻し、Cloud SQL に戻す。写しを取り直す | 再開 |

これまでの予備系（`infra/local/README.md`）は「DB の写しを手元に持ち、GCP 停止中は手元で見る・書く」だった。
この構想は **アプリの置き場所を平時から手元にし、DB だけを本番（Cloud SQL）に向ける**。
停止への備え（写しへの切り替え）は残す。

### 何が楽になるか

- 平時は本番 DB を直接見るので、**写しの鮮度を気にしなくてよい**（「データ YYYY-MM-DD 時点」の表示が要らなくなる）
- 本番停止中に手元で書いた分を戻す仕組み（`ops backup-begin / backup-export`、`docs/v3-backup-merge.md`）は
  **そのまま使える**。行ごとの変更記録、手元の id を 10 億番台、番号を 9000 番台に振る、本番の今の値と行ごとに比べる、はこの構想にも合う
- 戻すときも、手元から本番 DB へ届く経路ができるので、Cloud Shell へ SQL を上げる手間が消える

### 何が変わらない・失われるか

- GCP 停止中は **Cloud Run の口（Slack・依頼者アップロード・CloudSign の知らせ・定期実行）は止まる**。
  続けたければ口を Cloudflare 側へ移す（後の段）
- Drive・Gmail は Workspace なので GCP 停止の影響を受けない（既存どおり、人のログインで本番の SA になりすます。`docs/v3-local-gmail.md`）
- 手元の PC が止まれば止まる。常時稼働の PC か社内サーバに置く前提

## 1. 最大の関門：手元 → Cloud SQL の経路

社内ネットワークは **外向き 443 だけ通り、3307（Cloud SQL Auth Proxy）は拒否**、Cloud Storage のバケットは
契約の都合で作れない（`infra/local/README.md`「いまの状態」）。経路の候補は次のとおり。

| 経路 | 通り方 | 443 だけで通るか | 要るもの | 所見 |
|---|---|---|---|---|
| A | Cloud SQL Auth Proxy を PC（ops コンテナ）で直接 | ✕（3307） | ネットワーク担当に外向き TCP 3307 の許可 | 一番素直。許可が下りれば `.env` の差し替えだけ |
| B | Cloud SQL のパブリック IP + 承認済みネットワーク + SSL（5432） | 未確認（5432 が通るか） | 事務所の固定 IP、クライアント証明書 | 通れば追加コストなし。IP が変わると切れる |
| C | **IAP の TCP 転送 → 小さな GCE VM（cloud-sql-proxy 常駐）** | ○（`tunnel.cloudproxy.app:443`） | e2-micro 1 台、IAP の権限（`roles/iap.tunnelResourceAccessor`） | **一番現実的**。Google アカウントで認証、鍵不要。PC 側は `gcloud compute start-iap-tunnel` を常駐 |
| D | Cloudflare Tunnel を GCE VM に置き、Access の TCP で 5432 を通す | ○ | 同上 + Cloudflare の設定 | 既に Access を使っているので運用は揃う |
| E | Cloud Run に WebSocket ↔ PostgreSQL の自作ブリッジ | ○ | 自作コード、ID トークン認証 | C で足りるなら要らない |

**まず `ops netcheck` でどの経路が通るかを事務所から確かめる**（下の「いまの状態」）。
C か D ならネットワーク担当への依頼なしで着手できる。A は依頼が通れば最も簡単。

経路そのもの（IAP・VM）が落ちたときも「GCP 停止」と同じ扱いで写しへ切り替えればよい。

## 2. 写しの鮮度をどう保つか

| 方式 | 切替時の欠け（RPO） | 要るもの | 注意 |
|---|---|---|---|
| 毎晩の論理ダンプ（既存 `ops sync`） | 最大 1 日分 | 1 の経路のどれか。それ以外は実装済み | 3307 が塞がれて保留中だっただけで、経路ができれば今日から動く |
| 論理レプリケーション（Cloud SQL を publisher、ローカルを subscriber） | 数秒〜分 | Cloud SQL のフラグ `cloudsql.logical_decoding=on`（再起動 1 回）、レプリケーション権限のロール、手元からの常時接続 | 下の 4 点 |

論理レプリケーションの前提（2026-11-08 に repo の SQL で確認）：v3 の表 56 のうち主キーが無いのは
`condition_holder_190_review`（190 の見直し用）だけ。PDF の作り置き `document_pdfs` は `bytea` なので写せる。

注意点：

1. **DDL は流れない**。列を足す移行 SQL は本番と手元の両方に当てる（`ops upgrade` の運用そのもの）
2. **連番は流れない**。切替時に手元の連番を進める必要があるが、`backup-begin` が id を 10 億番台、番号を 9000 番台に振るので本番の連番を気にしなくてよい
3. **手元が長く落ちると Cloud SQL 側に WAL が溜まる**。`max_slot_wal_keep_size` で上限を切り、スロットの遅れを監視する。怠ると本番のディスクを食う
4. **切り替える前に購読を止める**。止めずに手元へ書くと、復旧した瞬間に本番の変更が流れ込んでぶつかる

**まず毎晩ダンプで動かし始め、経路が安定してから論理レプリケーションに上げる。** 前者は実装ゼロで、後者はその上に足せる。

## 3. 切り替え（failover）— 実装済み

app がつなぐ DB は **`/data/DB_TARGET` のファイル**（`primary`＝本番、`standby`＝手元の写し）で決まる
（`server/db/target.ts`、`config.ts`）。app と ops が同じ `/data` を見るので、`.env` を書き換えずに切り替わる。
ファイルが無ければ `DB_TARGET` の環境変数、それも無ければ従来どおり `DB_*`（いまの予備系・開発はそのまま動く）。
接続先は `PRIMARY_DB_*` / `STANDBY_DB_*`。`NUMBER_BAND=auto` なら本番につないでいるときだけ本番の連番で、写しでは 9000 番台。

手動の 1 コマンド `ops failover`：

1. 論理レプリケーションの購読があれば止める
2. `backup-begin`（ここからの変更を記録。id は 10 億番台、番号は 9000 番台）
3. `/data/DB_TARGET` を `standby` に
4. 人が `docker compose up -d app` で上げ直す（`READ_ONLY` が true なら false に）

**自動切替はしない。** トンネルの一時断でも「届かない」は起きるので、本番が生きているのに手元へ書き始めると
戻しのぶつかりが増える。app は `/api/v3/me` の `site.db` で「つないでいる DB・届くか・（写しのとき）本番に届くようになったか」を
返し、画面は左下に「DB：本番／手元の写し」、上に「本番 DB に届きません」「本番 DB に届くようになりました」を出す
（`server/db/probe.ts`。本番への確認は 3 秒で諦め、30 秒持ち回す）。

平時に、もう 1 つ読み取り専用の app を写しに向けて立てておくこともできる（切替の予行と、重い集計を写しで流す用途）。

## 4. 戻し（failback）— 実装済み

`ops failback check` → `ops failback apply`：

1. `backup-export` で持ち帰る SQL を作る
2. **手元から経路越しに本番へ `psql` で流す**（`PRIMARY_ADMIN_*`＝表の所有者。`docs/v3-backup-merge.md` の 5〜7 と同じ。Cloud Shell へのアップロードは要らない）。
   `check` は試すだけ。ぶつかりは `merge_skip=.. merge_force=..` を付けて流し直す
3. `apply` で確定できたら `backup-close merged`、`/data/DB_TARGET` を `primary` に
4. 人が app を上げ直し、写しを作り直す（ダンプなら `ops sync`、論理レプリケーションなら購読を作り直して初期コピー）

停止中に何も書かなかったなら `ops failback skip`。停止中に本番へも書き込みがあった場合（部分停止で Cloud Run の口だけ動いていた等）も、行ごとの比較で拾える。

## 4b. 予行（本番に触らずに一巡する）— 実装済み

`docker compose --profile rehearsal up -d db-primary` でもう 1 つの PostgreSQL を「本番役」に立て、
`ops rehearse-init` で手元の写しを入れる。`.env` の `PRIMARY_*` と `SYNC_DB_*` を本番役に向ければ、
平時（本番役に書く）→ `ops sync`（写し取り）→ `ops failover`（写しで書く）→ `ops failback`（戻す）→ `ops sync` を
経路なしで一巡できる。論理レプリケーションも、本番役と手元の間で publication / subscription を張れば、
「切り替える前に購読を止める」「戻したあと張り直す」まで試せる。手順は `infra/local/README.md`「予行」。

経路ができてから改めて試すのは、経路が切れたときの挙動（タイムアウト・再接続）だけ。

## 5. 平時の設定の違い（予備系との差分）

| 項目 | 予備系（今） | この構想の平時 |
|---|---|---|
| 接続先 | `DB_HOST=db`（ローカル） | `/data/DB_TARGET`＝`primary`、`PRIMARY_DB_*`＝本番（経路の口。例 `host.docker.internal:5433`、Secret Manager のパスワード）。写しは `STANDBY_DB_*`（既定は `db`） |
| `READ_ONLY` | `true` | `false`（本番に書く。停止中の写しでも書く） |
| `NUMBER_BAND` | `backup` | **`auto`**（本番につないでいるときだけ本番の連番。2 系統から同じ DB に書いても `document_sequences` で採番するので衝突しない。写しでは `backup`） |
| `SITE_LABEL` / `DATA_STAMP_PATH` | 予備系／写しの時点 | 「手元」などに。写しの時点は切替中だけ意味がある |
| `DB_POOL_MAX` | 5 | 経路越しは往復が重いので、少し増やす（10 程度）。本番の Cloud Run と合わせて接続数の上限を見る |

秘密情報は `.env` に置くので、PC のディスク暗号化が前提。

## 6. 進め方

1. **経路の確認**（着手済み）：`docker compose run --rm ops netcheck` で A〜D のどれが通るかを事務所から見る
2. **アプリ側と予行**（実装済み）：接続先の切り替え、`ops failover / failback`、本番役の DB での予行。経路が無くても一巡できる
3. 通った経路を 1 本立て、**手元の app を本番 Cloud SQL に読み取り専用でつなぐ**（`.env` の `PRIMARY_DB_*`・`READ_ONLY=true`。本番への書き込みはまだしない）
4. 同じ経路で `ops sync` を再開し、毎晩の写しを動かす（ここで「停止時に見られる」は成立）。`READ_ONLY=false` にして平時の形に
5. 鮮度が足りなければ論理レプリケーション、外の受付を続けたければ口を Cloudflare へ

## 7. 画面の形（モバイル・デスクトップ・Chrome 拡張）

「アプリを手元に置く」の「アプリ」は **サーバ（Express・Chromium の PDF・DB 接続）** で、PC 1 台で動かして皆で使う。
画面はそのサーバが配るウェブ画面で、ブラウザがあればスマホでも PC でも開ける（社外からは Cloudflare Tunnel + Access）。
画面の形を増やすとしても、サーバはこの形のまま。

| 形 | 向く用途 | 所見 |
|---|---|---|
| ウェブ画面（いま） + PWA | 全部 | 置き場所を変えずに、スマホのホーム画面・PC の「アプリとしてインストール」に出せる。**実装済み（2026-11-08）**：`public/manifest.webmanifest`・`public/sw.js`・`client/pwa.ts`。台帳（/api）は端末に置かず、index.html はネットワーク優先、資材（/assets）だけキャッシュ。新しい版は知らせて人が入れ替える。スマホ幅（760px 以下）は左の桁を上の帯に。入れ方は `infra/local/README.md`「スマホ・PC に「アプリ」として置く」 |
| Chrome 拡張 | Backlog・Gmail の画面から案件を開く、文書を作るボタン | 画面の置き換えではなく**足し物**。サーバは要る。配布（ストアか組織ポリシー）と Manifest V3 の手間 |
| デスクトップアプリ（Electron / Tauri） | 各 PC で単独に動かしたいとき | サーバと DB を抱き込めるが、「皆で 1 つの写しへ切り替える」設計と相性が悪い（どの PC の写しが正か）。Electron なら Chromium を同梱できるのは利点 |
| ネイティブのモバイルアプリ | 外出先の閲覧・承認 | 開発・配布の手間に見合う差が PWA と比べて小さい |

## いまの状態

- 2026-11-08：構想を書き、`ops netcheck` を経路ごとの判定に拡張（`infra/local/bin/ops.sh`）。事務所からの実測はこれから
- 2026-11-08：接続先の切り替え（`/data/DB_TARGET`・`PRIMARY_DB_*`・`STANDBY_DB_*`・`NUMBER_BAND=auto`）、画面の「DB：本番／手元の写し」と
  届かない・届くようになった知らせ、`ops target / failover / failback / rehearse-init`、本番役の DB（`--profile rehearsal`）。
  手元での予行はこれから（Docker のある PC で）
- 2026-11-08：PWA 化（manifest・service worker・アイコン・スマホ幅の帯・新しい版の知らせ・オフラインの知らせ）。ビルドした版を
  DB なしで立てて、Chromium で登録・manifest・オフラインの殻・390px/360px の見た目を確認
