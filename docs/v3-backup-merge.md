# 予備系で書いて、本番へ持ち帰る（本番にも書き込みがあってよい）

本番（Cloud Run・Cloud SQL）が止まっている間、予備系（ローカル版）を正として登録・決定し、
復旧したあとで本番へ持ち帰る手順。**止まっている間に本番にも書き込みがあってよい。**

`ops push-export`（`docs/v3-push-local-to-prod.md`）は本番 V3 を丸ごと入れ直すので、
本番に 1 件でも書き込みがあると使えない。こちらは予備系で変わった行だけを持ち帰り、
本番のいまの値と行ごとに比べて入れる。

## しくみ

| 何を | どうする |
|---|---|
| 予備系で変わった行 | `ops backup-begin` から先、v3 の全部の表（採番表を除く）の変更を行ごとに記録する（変わる前と後の値） |
| 予備系で作った行の id | 10 億番台から振る（`backup-begin` が連番を進める）。止まっている間に本番で作られた行の id とぶつからない。持ち帰るとき id をそのまま入れる |
| 文書番号・案件番号など | 予備系の番号帯で振る（4 桁なら 9000 番台、5 桁なら 90000 番台。`NUMBER_BAND=backup`）。本番の連番とぶつからず、**持ち帰っても番号は変わらない** |
| 持ち帰り | 行ごとに「写しの値（予備系で変わる前）」「予備系の値」「本番のいまの値」の 3 つで比べる |

行ごとの比べ方:

| 予備系で | 本番では | 結果 |
|---|---|---|
| 行を足した | 同じ主キーの行が無い | 足す |
|  | 同じ中身の行がもうある | 済み（何もしない） |
|  | 違う中身の行がある | **ぶつかり** |
| 行を直した | 直した列が写しのまま | 直す（予備系が触っていない列は本番の値のまま） |
|  | 同じ列を同じ値に直してある | 済み |
|  | 同じ列を別の値に直してある | **ぶつかり** |
|  | 行が消されている | **ぶつかり** |
| 行を消した | 写しのまま | 消す |
|  | もう無い | 済み |
|  | 直されている | **ぶつかり** |

入れたあと、業務の決まりが新しく崩れていないかも確かめる（崩れていれば止まる）:

- 訂正版と元が両方とも有効になっている
- 差し替え済みの文書に実績が結ばれたまま
- 同じ実績・同じ相手に支払が 2 件以上
- 同じ文書・条件・受取人の計算書が 2 件以上

本番の値と一意の決まり（同じ文書番号が 2 つ、など）や親子のつながり（親の行が無い子の行）も、
本番の制約でそのまま確かめる。

**1 件でもぶつかり・失敗・崩れがあれば何も変えない。** 人が見て、行ごとに「本番を正」
（`merge_skip`）か「予備系を正」（`merge_force`）を選んで流し直す。

## 本番が止まったとき（予備系の PC・PowerShell、infra\local で）

1. 写しを最新にする（いつもの同期・取り込み）。**記録を始める前に予備系で書いた分は持ち帰れない**ので、
   写しを入れ直した直後に始める。
2. 記録を始める:
   ```powershell
   docker compose run --rm ops backup-begin
   ```
3. `.env` を `READ_ONLY=false` にして、app を上げ直す:
   ```powershell
   docker compose up -d --build app
   ```
4. 予備系で作業する。文書番号は 9000 番台で振られる。CloudSign・Slack は止まっている。
   メールは既定で止まっているが、`docs/v3-local-gmail.md` の設定で予備系から送れる
   （送った記録も持ち帰る）。開けなければ、**相手への送付は復旧後に本番から**行う。
5. ときどき、書いた変更の数を見る:
   ```powershell
   docker compose run --rm ops backup-status
   ```

記録を閉じるまでは、`ops sync`・`ops restore`・`ops import-rows`・`ops fresh` は止まる
（予備系で書いた分が消えるため）。

## 復旧したあと

### 1. 予備系を読み取り専用に戻し、持ち帰る SQL を作る（PC）

```powershell
# .env を READ_ONLY=true に戻してから
docker compose up -d app
docker compose run --rm ops backup-export
```

`infra\local\dumps\merge\v3_merge_YYYYmmdd_HHMM.sql` ができる。最後に表ごとの
足した・直した・消した行の数が出る。

### 2. 本番を読み取り専用にする（Cloud Shell）

持ち帰りの間は、本番への書き込みを止める（入れる途中で本番の行が変わらないように。
外部キーの設定を一時的に変えるので、表を短時間つかむ）。

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars=READ_ONLY=true
```

### 3. 本番につなぎ、バックアップを取る（Cloud Shell）

つなぎ方は `docs/v3-deploy-cloudshell.md` の B・C と同じ。

```bash
cd ~/legalbridge_GCP_V2 && git pull
infra/gcp/start-sql-proxy.sh
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=legalbridge PGUSER=postgres
read -rsp "postgres のパスワード: " PGPASSWORD; echo; export PGPASSWORD
pg_dump -Fc --schema=v3 -f ~/v3_before_merge_$(date +%Y%m%d_%H%M).dump
```

### 4. 書き出した SQL を Cloud Shell へ上げる

右上「︙」→「アップロード」で `v3_merge_YYYYmmdd_HHMM.sql` を選ぶ（ホームに置かれる）。

### 5. まず試す（何も変えない）

```bash
psql -f ~/v3_merge_YYYYmmdd_HHMM.sql
```

最後に「試しただけです（check）。何も変えていません」と出て、「見てほしいもの」が空なら 7 へ。

### 6. ぶつかり・失敗・崩れがあったら

「見てほしいもの」に、番号・表・主キー・中身（本番／予備系／写しの値）が出る。
表ごとの行を見たいときは `merge_show` に表の名前を入れる:

```bash
psql -v merge_show=payments,payment_allocations -f ~/v3_merge_YYYYmmdd_HHMM.sql
```

行ごとに決めて、番号を入れて **もう一度 check から**流す:

| 決め方 | 付ける変数 | どうなる |
|---|---|---|
| 本番の値を正とする（予備系のその変更は捨てる） | `-v merge_skip=12,57` | その行は入れない |
| 予備系の値を正とする | `-v merge_force=33` | 本番の値を予備系の値で上書きする（消された行は予備系の値で足し直す） |

```bash
psql -v merge_skip=12,57 -v merge_force=33 -f ~/v3_merge_YYYYmmdd_HHMM.sql
```

よくある形:

- **同じ文書を両方で訂正した**（文書番号の一意でぶつかる）→ どちらか一方の訂正版だけを残す。
  予備系の分を捨てるなら、その訂正版の行と、それに付いた計算書・明細・実績の付け替えの行も
  まとめて `merge_skip` に入れる（親を捨てて子だけ入れると「親子のつながりが切れる」で止まる）。
- **同じ実績に両方で支払を立てた**（業務の決まりの崩れ）→ `merge_show=payments,payment_allocations`
  で予備系の支払の番号を見て、どちらかを捨てる。
- **同じ取引先を両方で足した**（取引先コードの一意でぶつかる）→ 予備系の分を捨て、予備系でその取引先に
  付けた行は、本番の取引先に付け替えて本番で入れ直す。

### 7. 確定する

```bash
psql -v merge_mode=apply [-v merge_skip=… -v merge_force=…] -f ~/v3_merge_YYYYmmdd_HHMM.sql
```

「持ち帰りました（確定）」と出れば完了。本番の audit_events に `ops.merge_from_backup` が残る。
確定はぶつかり・失敗・崩れが 0 件のときだけ行われる。同じファイルをもう一度流しても、
入れた行は「本番でもう同じ」になるだけで、二重には入らない。

### 8. 本番の読み取り専用を解く（Cloud Shell）

```bash
gcloud run services update legalbridge-v3 --region=asia-northeast1 \
  --update-env-vars=READ_ONLY=false
```

本番の画面で、予備系で作った文書（9000 番台）・案件などが見えることを確かめる。
相手への送付（Gmail・CloudSign）はここから本番で行う。

### 9. 予備系の記録を閉じる（PC）

```powershell
docker compose run --rm ops backup-close merged
```

記録の引き金が外れ、写しの入れ直しが再びできるようになる。次に写しを取り込むと、
予備系は本番（持ち帰った分を含む）の中身に戻る。

持ち帰らずに捨てるときは `ops backup-close discard`。

### 10. 後片付け

- Cloud Shell: `rm ~/v3_merge_*.sql`（バックアップ `~/v3_before_merge_*.dump` は 1 週間ほど置いてから消す）
- PC: `infra\local\dumps\merge\` の中身を消す

## 気をつけること

- **ファイル。** ひな形から作った文書の PDF は持ち帰らない（本番で文書の本文から作り直す）。
  取り込んだ PDF など、予備系の `data/files` にしか無いファイルは「ローカルにしか無いファイル」に
  出るので、本番で手で上げ直す。
- **本番の列が古いと止まる。** 予備系にあって本番に無い列があれば、先に本番へ
  `infra/v3/004_amend_studio.sql` を当てる。
- **行ごとに比べるので、行をまたぐ食い違いは決まりの確認に頼る。** たとえば両方で別々に
  同じ回の計算書を出した、のような食い違いは、上の 4 つの決まりで見つかるものだけ止まる。
  「持ち帰る行（表ごと）」の数を見て、止まっている間に本番でも同じ仕事をしていないか確かめる。
- **番号。** 予備系の番号帯（9000 番台）の番号は本番に入っても動かない。本番の連番は
  帯の番号を数えないので、持ち帰ったあとも本番は通常の続き番号から振る。
- **口座番号・名義・連絡先を含むことがある。** 書き出した SQL の置き場所に気をつけ、終わったら消す。

## 戻し方（持ち帰りを取り消す）

手順 3 のバックアップで、持ち帰る前の本番 V3 に戻す。手順は
`docs/v3-push-local-to-prod.md` の「戻し方」と同じ（ファイル名を `v3_before_merge_…` に読み替える）。
