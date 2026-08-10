# Phase 11：設定・マスタ書込（運用自立）

V2 の Admin は読取専用ステータスのみ。設定・承認ルート・台帳/契約マスタの編集系が欠落しており、
管理者が V2 だけで運用を自己完結できない（cutover の Tier 1 ブロッカー）。本フェーズで解消する。

## スライス

| # | 機能 | 粒度 | 状態 |
|---|---|---|---|
| 11-1 | システム設定（会社プロファイル） | 中 | ✅ 実装済 |
| 11-2 | 承認ルート/ワークフロールール設定 | 中 | 未 |
| 11-3 | 台帳マスタ CRUD 書込 | 中 | 未 |
| 11-4 | 契約マスタ CRUD | 中 | 未 |
| 11-5 | 原作マテリアル登録ワークフロー | 中 | 未 |
| 11-6〜11-9 | PII同意/bulk/テーマ/稟議 | 小〜中 | 優先低・要判断（Ringi 保留） |

## 11-1：システム設定（会社プロファイル）✅ 実装済

共有 `app_settings`（`key VARCHAR PK / value JSONB`）を V2 が所有・編集する。V1 も同表を参照するため
V1/V2 で自社情報が一貫する。**安全のため編集可能キーは会社プロファイル（表示用・非機密）に allowlist**。
連携トグルや秘密（INTEGRATION_MODE・各種トークン）は env/デプロイ管理のまま＝ここでは触らない。

- `settings/settings-schema.ts`：`COMPANY_PROFILE_FIELDS`（会社名/カナ/郵便番号/住所/TEL/FAX/代表者/
  適格請求書番号(T)/振込先/備考）＋`ALLOWED_SETTING_KEYS`＋`settingsSaveSchema`（allowlist 外キーは 400）。
- **grant 036**（`036_production_app_settings_grants.sql`＋preflight）：`app_settings` に SELECT/INSERT/UPDATE
  （upsert 用）。token `GRANT_PRODUCTION_APP_SETTINGS`。行削除は許可しない。
- `settings/settings-repository.ts`（Pg/Memory）：`get(keys)`（JSONB→文字列・42P01 は空縮退）／
  `save(values)`（`INSERT ... ON CONFLICT (key) DO UPDATE`・JSON 文字列で格納・42501 は throw）。
- `settings/settings-routes.ts`：`GET /settings`（**admin のみ**・現在値＋フィールド定義）＋
  `POST /settings`（guarded・admin のみ・allowlist・42501→FORBIDDEN_DB）。
- config `SETTINGS_WRITE_ENABLED`／app.ts（gating・safe-write scope `settings`・writeCapabilities）／
  verify（write-test＋IAP/IAM＋WRITE_SCOPES 正準順に `settings`）／cloudbuild 全結線。
- UI：`SettingsWorkspace`（マスタ・設定＞システム設定・admin）＝会社プロファイル編集フォーム
  （capability 有効時のみ保存・変更キーのみ送信・未有効化は FeatureLockedNote で閲覧のみ）。
- tests：403/現在値/無効時503/保存/allowlist外400/空400/FORBIDDEN_DB の 7 件。623 緑。

### 点火（本番）
```bash
psql "" -f infra/gcp/sql/036_production_app_settings_preflight.sql || true
psql "" -v confirm_app_settings=GRANT_PRODUCTION_APP_SETTINGS \
  -f infra/gcp/sql/036_production_app_settings_grants.sql
```
Profile D substitutions 末尾へ `|_SETTINGS_WRITE_ENABLED=true`、`_WRITE_SCOPES` の `excel-batch`
直後に `settings` を追加（正準順）。**閲覧は grant/フラグ不要**（app_settings が空でも空表示）、
編集のみ点火が要る。

> 将来：V2 の帳票レンダリング（テンプレート）に会社プロファイルを差し込む配線は別スライスで
> （現状 app_settings は保存されるが V2 レンダリングは未参照＝V1 と共有データの先行整備）。

## 次スライス候補
- **11-3 台帳マスタ CRUD**（作品・取引先などの作成/更新/削除・現状 GET のみ）
- **11-2 承認ルート**（部門別 承認者/押印/Slack）
- **11-5 原作マテリアル登録**
