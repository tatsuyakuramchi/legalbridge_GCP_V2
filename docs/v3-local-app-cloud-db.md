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

## 3. 切り替え（failover）

手動の 1 コマンド `ops failover` にする（これから作る）：

1. 購読を止める（論理レプリケーションのとき）
2. `ops backup-begin`（ここからの変更を記録。id・番号の帯を予備系のものにする）
3. `.env` の `DB_HOST` をローカル db に、`READ_ONLY=false`、`NUMBER_BAND=backup`
4. app を上げ直す

**自動切替はしない。** トンネルの一時断でも「届かない」は起きるので、本番が生きているのに手元へ書き始めると
戻しのぶつかりが増える。app が本番 DB に届かないときは **画面に「本番 DB に届きません」と出して管理者に切替を促す**、までが安全な範囲。

平時に、もう 1 つ読み取り専用の app を写しに向けて立てておくこともできる（切替の予行と、重い集計を写しで流す用途）。

## 4. 戻し（failback）

`ops failback`（これから作る）：

1. 手元の app を `READ_ONLY=true` に
2. `ops backup-export` → できた SQL を **手元から経路越しに本番へ `psql` で流す**（`docs/v3-backup-merge.md` の 5〜7 と同じ。Cloud Shell へのアップロードは要らない）
3. `.env` の `DB_HOST` を本番に戻し、`NUMBER_BAND` を外して app を上げ直す
4. 写しを作り直す（ダンプなら `ops sync`、論理レプリケーションなら購読を作り直して初期コピー）
5. `ops backup-close merged`

停止中に本番へも書き込みがあった場合（部分停止で Cloud Run の口だけ動いていた等）も、行ごとの比較で拾える。

## 5. 平時の設定の違い（予備系との差分）

| 項目 | 予備系（今） | この構想の平時 |
|---|---|---|
| `DB_HOST` | `db`（ローカル） | 本番（経路の口。例 `host.docker.internal:5433`） |
| `DB_USER` | `legalbridge_v3_runtime`（ローカルに作ったロール） | 本番の `legalbridge_v3_runtime`（Secret Manager のパスワードを `.env` へ） |
| `READ_ONLY` | `true` | `false`（本番に書く） |
| `NUMBER_BAND` | `backup` | **外す**（本番の連番で振る。2 系統から同じ DB に書いても `document_sequences` で採番するので衝突しない） |
| `SITE_LABEL` / `DATA_STAMP_PATH` | 予備系／写しの時点 | 「手元」などに。写しの時点は切替中だけ意味がある |
| `DB_POOL_MAX` | 5 | 経路越しは往復が重いので、少し増やす（10 程度）。本番の Cloud Run と合わせて接続数の上限を見る |

秘密情報は `.env` に置くので、PC のディスク暗号化が前提。

## 6. 進め方

1. **経路の確認**（着手済み）：`docker compose run --rm ops netcheck` で A〜D のどれが通るかを事務所から見る
2. 通った経路を 1 本立て、**手元の app を本番 Cloud SQL に読み取り専用でつなぐ**（既存 compose の `DB_HOST` 差し替え。本番への書き込みはまだしない）
3. 同じ経路で `ops sync` を再開し、毎晩の写しを動かす（ここで「停止時に見られる」は成立）
4. `ops failover / failback` を作り、予行する（`backup-begin` 以降は既存）
5. 鮮度が足りなければ論理レプリケーション、外の受付を続けたければ口を Cloudflare へ

## いまの状態

- 2026-11-08：構想を書き、`ops netcheck` を経路ごとの判定に拡張（`infra/local/bin/ops.sh`）。事務所からの実測はこれから
