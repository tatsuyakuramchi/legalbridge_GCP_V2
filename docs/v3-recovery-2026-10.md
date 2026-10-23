# 2026-10 の復旧：本番へ戻す手順（この停止のぶん）

本番（Cloud Run・Cloud SQL）が止まっていた 2026-10 のあいだ、予備系で `ops backup-begin` から
書いて作業した。本番が戻ったので、**本番のアプリを最新にし、予備系で作った分を本番へ持ち帰り、
予備系を写しに戻す**。一般の手順は `docs/v3-backup-merge.md`。ここは今回の順番だけ。

順番が大事。**表を足す移行（172）は持ち帰りの前**、**データを直す移行（173・174・145・169・170）は
持ち帰りの後**、**アプリのデプロイは最後**（デプロイは READ_ONLY=false で上げ直すので、持ち帰りが
終わるまで出さない）。

## 0. 前提

- 予備系は `ops backup-begin` 済み（文書番号が 9000 番台で振られている）。
- 停止中に予備系へ流した移行 SQL：`172_multi_party.sql`・`173_terms_agreement_numbers.sql`・
  `174_strip_share_placeholder_note.sql`・`145_strip_invoice_no_prefix.sql`・`169_service_completion_notice.sql`。
- このブランチの最後の変更が main に入っていること（PR をマージする。マージすると Cloud Build の
  トリガーが走って本番に載る。**手順 6 までは main にマージしない**）。

## 1. 本番を止める（Cloud Shell）

```bash
gcloud config set project legalbridge-488506
gcloud run services update legalbridge-v3 --region=asia-northeast1 --update-env-vars=READ_ONLY=true
cd ~/legalbridge_GCP_V2 && git pull
infra/gcp/start-sql-proxy.sh
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=legalbridge PGUSER=postgres
read -rsp "postgres のパスワード: " PGPASSWORD; echo; export PGPASSWORD
psql -c "SELECT current_user, current_database();"
pg_dump -Fc --schema=v3 -f ~/v3_before_merge_$(date +%Y%m%d_%H%M).dump
ls -lh ~/v3_before_merge_*.dump
```

## 2. 本番の表を予備系と同じ形にする（Cloud Shell）

列と表を足すだけ。中身は変えない。何度流しても同じ。

```bash
psql -v ON_ERROR_STOP=1 -f infra/v3/004_amend.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/171_paydocs.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/172_multi_party.sql
psql -c "SELECT table_name FROM information_schema.tables WHERE table_schema='v3' AND table_name IN ('document_parties','agreement_successions','production_plans')"
```

3 つの表が出れば OK。

## 3. 予備系で持ち帰る SQL を作る（PC・PowerShell、infra\local で）

```powershell
cd C:\Users\tatsuya.kuramochi\legalbridge_GCP_V2
git fetch origin claude/sweet-hamilton-l3y137
git merge origin/claude/sweet-hamilton-l3y137
cd infra\local
# .env を READ_ONLY=true に戻す（ここから予備系には書かない）
docker compose up -d app
docker compose run --rm ops backup-attach    # 172 で足した表にも引き金を付け、その行を記録する
docker compose run --rm ops backup-status    # 持ち帰る行の数を見る
docker compose run --rm ops backup-export
```

`infra\local\dumps\merge\v3_merge_YYYYmmdd_HHMM.sql` ができる。口座・連絡先が入るので置き場所に気をつける。

## 4. 持ち帰る（Cloud Shell）

Cloud Shell の右上「︙」→「アップロード」で `v3_merge_….sql` を上げる。

```bash
psql -f ~/v3_merge_YYYYmmdd_HHMM.sql                     # 試す（何も変えない）
```

「見てほしいもの」が空なら確定。空でなければ `docs/v3-backup-merge.md` の 6 のとおり、行ごとに
`merge_skip`（本番を正）か `merge_force`（予備系を正）を決めて、もう一度 check から。

```bash
psql -v merge_mode=apply -f ~/v3_merge_YYYYmmdd_HHMM.sql   # 確定
psql -c "SELECT action, occurred_at FROM v3.audit_events WHERE action = 'ops.merge_from_backup' ORDER BY 2 DESC LIMIT 1"
```

今回ありそうなぶつかり：
- 停止中に本番でも同じ取引先・同じ文書を直していた → 行ごとに決める。
- 本番にしか無い列は構わない。予備系にしか無い列があれば手順 2 の当て忘れ。

## 5. データを直す移行を本番にも流す（Cloud Shell）

予備系で流した分。持ち帰りで既に入っていれば何もしない（何度流しても同じ）。

```bash
psql -v ON_ERROR_STOP=1 -f infra/v3/173_terms_agreement_numbers.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/174_strip_share_placeholder_note.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/145_strip_invoice_no_prefix.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/169_service_completion_notice.sql
psql -v ON_ERROR_STOP=1 -f infra/v3/170_inspection_layout_v2.sql
```

確かめる：

```bash
psql -c "SELECT t.template_key, v.version_no, t.current_version_id = v.id AS current FROM v3.document_templates t JOIN v3.document_template_versions v ON v.template_id = t.id WHERE t.template_key IN ('service_completion_notice','inspection_certificate') ORDER BY 1, 2"
psql -c "SELECT count(*) FROM v3.documents WHERE document_no LIKE 'ARC-SC-2026-90%'"
```

9000 番台の通知書が数えられれば持ち帰れている。

## 6. アプリを本番に載せる（GitHub）

`claude/sweet-hamilton-l3y137` → `main` の PR を作ってマージする。Cloud Build のトリガー
（`legalbridge-v3-deploy`）が走り、`READ_ONLY=false` で上がる（デプロイが読み取り専用を解く）。
Cloud Build の画面で緑になるのを待つ。

マージ済みなのにトリガーが走っていなければ（請求停止中にマージした場合など）、**トリガーを手で走らせる**：

```bash
gcloud builds triggers run legalbridge-v3-deploy --branch=main
gcloud builds list --limit=1 --format='table(id,status,createTime)'
```

**`gcloud builds submit` を手で流してはいけない。** 本番用の設定（認証 iap・Gmail/CloudSign/Slack/Backlog の
live・Drive のフォルダ・鍵）はトリガーの代入変数に入っていて、手動の submit は `cloudbuild.yaml` の既定値
（全部 off・認証 disabled）で上がる（2026-10-23 に実際に起きた）。

本番の画面で確かめる：ホーム（#/home）の盤面が出る、取引先⇔基本契約で「送る」欄と「別の基本契約に寄せる」が出る、
予備系で作った 9000 番台の文書が開けて PDF が出る（本番で本文から作り直す）。

本番の Gmail・CloudSign はこれまでどおり（予備系の設定とは別）。予備系の Google ログイン（GOOGLE_LOGIN_*）は
本番には関係ない。

## 7. 予備系を写しに戻す（PC）

```powershell
docker compose run --rm ops backup-close merged
docker compose run --rm ops sync
```

これで予備系は本番（持ち帰った分を含む）の写しに戻り、以後は毎晩の `ops sync` で本番と対になる。
`.env` は `READ_ONLY=true`・`GMAIL_MODE=off`・`CLOUDSIGN_MODE=off` に戻しておく。

## 8. 後片付け

- Cloud Shell：`rm ~/v3_merge_*.sql`。`~/v3_before_merge_*.dump` は 1 週間置いてから消す。
- PC：`infra\local\dumps\merge\` の中身を消す。
- 予備系の `data/files` にしか無い取り込み PDF は、持ち帰りの「ローカルにしか無いファイル」に出る。本番で上げ直す。

## 戻し方

`docs/v3-push-local-to-prod.md` の「戻し方」と同じ（`v3_before_merge_…` を使う）。
