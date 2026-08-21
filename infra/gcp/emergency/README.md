# LegalBridge V2 緊急登録バンドル

「LegalBridge V2停止時 緊急DB登録・CSV作成マニュアル」（Word・社内限定）の付属バンドル。
V2 が停止し **DB（Cloud SQL `legalbridge`）が正常** な場合にだけ使用する。
利用者向けの概要は利用者マニュアル第11章、発動条件・役割分担は Word マニュアルが正本。

## 構成

```
templates/  CSVひな形（UTF-8 BOM・ヘッダーのみ）
  master_vendors.csv                 取引先（口座情報は含まない）
  master_vendors_bank_sensitive.csv  取引先の口座情報（管理者承認時のみ）
  master_staff.csv                   担当者
  documents_generic.csv              確定文書（1ファイル1行推奨・form_data はJSON）
  operation_manifest.csv             運用記録票
sql/
  00_preflight.sql             事前確認（書込みなし・何度でも実行可）
  01_import_vendors.sql        取引先の登録（同名スキップ・VEN-採番）
  02_import_staff.sql          担当者の登録（同名スキップ）
  03_import_documents.sql      文書の登録（emergency_ref 重複拒否・本番採番表で自動採番）
  90_create_emergency_role.sql 緊急ロール作成（管理者が事前に1回。平時 NOLOGIN）
```

## 事前整備（平時にやっておくこと）

```bash
# 管理者DSNで1回だけ（NOLOGIN で作成される）
psql "$RUNTIME_ADMIN_DSN" -v confirm_emergency_role=CREATE_EMERGENCY_ROLE \
  -f infra/gcp/emergency/sql/90_create_emergency_role.sql
```

## 発動時の実行手順（DB実行者）

```bash
# 0) 管理者がロールを起こす（期限付き・終了後 NOLOGIN に戻す）
#    ALTER ROLE legalbridge_emergency LOGIN PASSWORD '...' VALID UNTIL '...';

cd ~/legalbridge_GCP_V2
mkdir -p work
cp infra/gcp/emergency/templates/master_vendors.csv work/   # 必要なひな形をコピー
# → 法務担当が work/ 内のCSVを作成し、別担当レビュー＋SHA-256記録＋承認を得る
sha256sum work/*.csv

export EMERGENCY_DSN="host=127.0.0.1 port=5432 dbname=legalbridge user=legalbridge_emergency"
psql "$EMERGENCY_DSN" -f infra/gcp/emergency/sql/00_preflight.sql

psql "$EMERGENCY_DSN" -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
  -v csv=work/master_vendors.csv -f infra/gcp/emergency/sql/01_import_vendors.sql
psql "$EMERGENCY_DSN" -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
  -v csv=work/master_staff.csv   -f infra/gcp/emergency/sql/02_import_staff.sql
psql "$EMERGENCY_DSN" -v confirm=LEGALBRIDGE_EMERGENCY_WRITE \
  -v csv=work/documents_generic.csv -f infra/gcp/emergency/sql/03_import_documents.sql
```

## 安全設計（各SQLに共通）

- `confirm=LEGALBRIDGE_EMERGENCY_WRITE` が無いと何もせず終了（fail-closed）
- CSV は本番テーブルへ直接 COPY せず、TEMP staging → 検証 → 明示列 INSERT
- 検証エラーは全体 ROLLBACK（部分登録は起きない）
- 冪等性: マスタは同名スキップ、文書は `emergency_ref`（form_data 内 EMERGENCY_REF）で再実行を拒否
- 文書番号は空欄なら本番と同じ `document_sequences` で採番＝**V2復旧後の採番と衝突しない**
- DELETE / TRUNCATE / UPDATE（採番以外）は含まない。ロールにも権限を与えない
