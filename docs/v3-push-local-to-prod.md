# ローカル（予備系）の中身で本番 V3 を入れ直す

本番（Cloud Run）が止まっている間、ローカル版を正として作業した分を、本番へ持ち帰る手順。
**本番 V3 の中身を丸ごとローカルの中身に置き換える**。V2・V1（public スキーマ）には触らない。

使ってよいのは、**写しを取った時点から本番 V3 に誰も書き込んでいない**ときだけ。
流す SQL の先頭でも確かめ、書き込みがあれば何もせずに止まる。

## 前提と注意

- 写しの時点は `ops sql /v3/diag/local-changes.sql` の「対象の期間」の起点
  （import-rows で取り込んだときの操作記録の最後。2026-09 の作業では 2026-09-09 21:13:53）。
- 本番がその時点から変わっていないことを Studio で確かめておく:
  ```sql
  SELECT count(*) FROM v3.audit_events
   WHERE occurred_at > TIMESTAMPTZ '2026-09-09 21:13:53+09' AND action <> 'job.daily';
  ```
  → **0 件**であること。
- **作業中は本番もローカルも使わない。** 本番で入れた分は消え、ローカルで入れた分は持ち帰れない。
- **作業中は main に push しない。** 自動デプロイが走ると、手順 1 の読み取り専用が解ける
  （デプロイは環境変数を全部入れ直す）。
- 流す SQL には口座番号・名義・連絡先が入る。置き場所に気をつけ、終わったら消す（手順 10）。

## 流す SQL がすること（1 トランザクション）

`ops push-export` が作る `v3_push_YYYYmmdd_HHMM.sql` は、次を 1 つのトランザクションで行う。
**途中で 1 つでも失敗すれば、本番は何も変わらない。**

1. 本番が写しの時点から変わっていないかを確かめる（変わっていれば止まる）
2. 表の列がローカルと本番で同じかを確かめる（004_amend の当て忘れなら止まる）
3. 外部キーを一時的に「最後に確かめる」にし、利用者の引き金を止める
   （Cloud SQL には superuser が無いので、ローカルの取り込みと同じ止め方はできない）
4. v3 の全部の表を空にして、ローカルの中身を入れる（番号の採番表・連番も同じ値になる）
5. ローカルにしか無い PDF の保存先（`/local-files/`）を消す（本番では文書の本文から作り直す）
6. 外部キーを確かめて元に戻し、表ごとの行数がローカルと同じかを数える
7. 入れ直した記録（`ops.push_from_local`）を audit_events に残す

---

## 1. 本番を読み取り専用にする（Cloud Shell）

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars=READ_ONLY=true
```

## 2. ローカルを最新にして書き出す（PC・PowerShell、infra\local で）

```powershell
git pull
docker compose up -d --build app
docker compose run --rm ops upgrade
docker compose run --rm ops push-export
```

`infra\local\dumps\push\v3_push_YYYYmmdd_HHMM.sql` ができる。最後に出る
「写しの時点」が上の前提と同じ時刻であることを確かめる。

> 起点を手で決めたいとき（取り込みを import-rows 以外で行った場合など）は
> `docker compose run --rm -e PUSH_SINCE="2026-09-09T21:13:53+09" ops push-export`

## 3. 本番の表をローカルと同じ形にする（Cloud SQL Studio）

`infra/v3/004_amend_studio.sql` を Studio で流す。最後の確認一覧で **51 番が 11** なら OK。

147・148（発注書のひな形）は流さなくてよい。ひな形もローカルの中身ごと入れ直す。

## 4. Cloud Shell で本番につなぐ

`docs/v3-deploy-cloudshell.md` の B・C と同じ。

```bash
cd ~/legalbridge_GCP_V2 && git pull
infra/gcp/start-sql-proxy.sh
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=legalbridge PGUSER=postgres
read -rsp "postgres のパスワード: " PGPASSWORD; echo; export PGPASSWORD
psql -c "SELECT current_user, current_database();"
```

## 5. 本番 V3 のバックアップを取る（Cloud Shell）

```bash
pg_dump -Fc --schema=v3 -f ~/v3_before_push_$(date +%Y%m%d_%H%M).dump
ls -lh ~/v3_before_push_*.dump
```

戻すときはこのファイルを使う（末尾「戻し方」）。

## 6. 書き出した SQL を Cloud Shell へ上げる

Cloud Shell の右上「︙」→「アップロード」で `v3_push_YYYYmmdd_HHMM.sql` を選ぶ（ホームに置かれる）。

## 7. 流す（Cloud Shell）

```bash
psql -v ON_ERROR_STOP=1 -v confirm_push=REPLACE_V3_WITH_LOCAL -f ~/v3_push_YYYYmmdd_HHMM.sql
```

最後に `COMMIT` と表ごとの行数が出れば完了。止まったときは本番は何も変わっていない:

| 出るエラー | 意味と対処 |
|---|---|
| 本番に写しの時点より後の操作が N 件あります | 本番で誰かが書き込んだ。入れ直すと消えるので止まった。中身を確かめてから相談 |
| 列がローカルと本番で違います | 手順 3（004_amend）が本番に当たっていない。当ててからもう一度 |
| 行数が合いません | 書き出しと流す間にローカルが変わった可能性。手順 2 からやり直す |
| lock timeout / canceling statement due to lock timeout | 本番のアプリが表をつかんでいる。手順 1 を確かめ、少し待ってもう一度 |

## 8. 確かめる（Cloud Shell）

```bash
psql -c "SELECT prefix, year, current_value FROM v3.document_sequences WHERE prefix IN ('PO','INS','WRK','MTR','CL','PAY') ORDER BY 1"
psql -c "SELECT max(document_no) FILTER (WHERE document_no LIKE 'ARC-PO-%') AS po, max(document_no) FILTER (WHERE document_no LIKE 'ARC-INS-%') AS ins FROM v3.documents"
psql -c "SELECT action, occurred_at FROM v3.audit_events WHERE action = 'ops.push_from_local'"
```

ローカルの画面で見ていた最後の文書番号・作品番号と同じであること。

## 9. 読み取り専用を解く（Cloud Shell）

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars=READ_ONLY=false
```

本番の画面で、ローカルで作った作品・文書が見えること、PDF が開けることを確かめる。

## 10. 後片付け

- Cloud Shell: `rm ~/v3_push_*.sql`（バックアップ `~/v3_before_push_*.dump` は 1 週間ほど置いてから消す）
- PC: `infra\local\dumps\push\` の中身を消す
- これ以降、本番が正。ローカルは予備系に戻る（次に写しを取り込むと、本番の中身で上書きされる）

---

## 戻し方（入れ直しを取り消す）

手順 5 のバックアップで、入れ直す前の本番 V3 に戻す。先に手順 1 で読み取り専用にしておく。

まず、消える物の一覧だけを見る（COMMIT しないので、psql が終わると自動で取り消される）:

```bash
psql <<'SQL'
BEGIN;
DROP SCHEMA v3 CASCADE;
ROLLBACK;
SQL
```

出た NOTICE（drop cascades to …）が **v3 の物だけ**なら次へ。v3 の外（public など）の
名前が出たら、そこで止めて相談する。

```bash
cd ~/legalbridge_GCP_V2
psql -v ON_ERROR_STOP=1 -c "DROP SCHEMA v3 CASCADE"
pg_restore --no-owner -d legalbridge ~/v3_before_push_YYYYmmdd_HHMM.dump
psql -v ON_ERROR_STOP=1 -v confirm_v3_grants=GRANT_V3_RUNTIME -f infra/v3/003_grants.sql
```
