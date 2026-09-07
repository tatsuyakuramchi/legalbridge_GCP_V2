# コアスキーマ再設計案（破壊的変更・条件を軸に）

現行の互換境界（既存テーブル構造を変更しない）を**外す前提**の設計案。
「条件を軸にした構造は正しいが、周辺に余計なものが多い」という評価を出発点に、
**約50リレーション → 27テーブル**へ整理する。

> **前提の変更**：本案は V1 と同一DBを共有できない。採用する場合、
> README の互換境界4項目のうち「既存テーブル構造を変更しない」を正式に解除し、
> **V1停止をロードマップに載せる**ことが着手条件になる。

---

## 1. 設計原則

| # | 原則 | 現行の何を否定するか |
|---|---|---|
| 1 | **条件が軸。文書は条件の出力物** | `condition_lines.document_id`（条件が文書に従属）を反転する |
| 2 | **1事実1箇所。派生値は列にせずビューで出す** | `documents` の契約業務列12＋スナップショット9 |
| 3 | **状態はNULLを許さない** | `lifecycle_status IS NULL` のレガシー行 |
| 4 | **向き・区分は1列** | `direction`/`flow_direction`/`is_inbound` の3重化 |
| 5 | **自由キーのJSONを業務データにしない** | `form_data` の10種の相手先キー |
| 6 | **金額は最小通貨単位の整数、料率は百万分率の整数** | numeric混在と `Math.ceil` の散在 |
| 7 | **監査は1表に集約、append-only** | `lb_v2_*` 12表 |
| 8 | **案件は制御であって所有ではない** | 案件が終わると条件・作品も追えなくなる運用 |
| 9 | **合意・条件・実績を3層に分ける** | 契約情報が `documents` と `contracts` に二重に載る構造 |

---

## 2. 新スキーマ（27テーブル）

### 2.1 当事者

```sql
CREATE TABLE parties (                       -- 現 vendors
  id             bigserial PRIMARY KEY,
  party_code     text UNIQUE,
  kind           text NOT NULL CHECK (kind IN ('corporate','individual')),
  name           text NOT NULL,
  name_kana      text,
  aliases        text[] NOT NULL DEFAULT '{}',   -- 屋号・ペンネーム・旧称を1列に
  invoice_no     text,
  corporate_no   text,
  withholding    boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','archived','merged')),
  merged_into_id bigint REFERENCES parties(id), -- 名寄せは行を消さずここで表現
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE party_contacts (
  id bigserial PRIMARY KEY,
  party_id bigint NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('primary','signer','billing')),
  name text, email text, phone text, department text,
  UNIQUE (party_id, role)
);

-- 機微情報を物理分離。列レベルGRANTが不要になり、表レベルで隔離できる。
CREATE TABLE party_bank_accounts (
  party_id bigint PRIMARY KEY REFERENCES parties(id) ON DELETE CASCADE,
  bank_name text, branch_name text, account_type text,
  account_number text, account_holder_kana text
);

CREATE TABLE staff (
  id bigserial PRIMARY KEY, staff_code text UNIQUE, name text NOT NULL,
  email text UNIQUE, department text, slack_user_id text,
  status text NOT NULL DEFAULT 'active'
);
```

**変わる点**：`vendors` の `vendor_name` / `trade_name` / `pen_name` の3列＋名前解決の順序ロジックが
`name` ＋ `aliases[]` に畳まれる。名寄せは `merged_into_id` の1列で表現され、
**9表を1トランザクションで付け替える処理が不要になる**（参照は生きたまま `merged_into_id` を辿る）。

### 2.2 作品

```sql
CREATE TABLE works (
  id bigserial PRIMARY KEY,
  work_code text UNIQUE,
  title text NOT NULL, title_kana text,
  kind text NOT NULL,                          -- own / source_ip / anthology …
  business_line text,
  status text NOT NULL DEFAULT 'planning'
         CHECK (status IN ('planning','in_production','released','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_parts (                      -- 現 work_materials
  id bigserial PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  part_no int NOT NULL,
  name text NOT NULL,
  part_type text NOT NULL,                     -- illustration / music / text / translation …
  royalty_bearing boolean NOT NULL DEFAULT true,
  UNIQUE (work_id, part_no)
);

CREATE TABLE work_lineage (                    -- 現 work_relations（works.parent_work_id は廃止）
  parent_work_id bigint NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  child_work_id  bigint NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  relation_type  text NOT NULL,
  PRIMARY KEY (parent_work_id, child_work_id, relation_type),
  CHECK (parent_work_id <> child_work_id)
);
```

**廃止**：`source_ips`（`works.kind='source_ip'` に統合）、`material_categories`、
`material_rights_sources`、`work_material_uses`。
**権利の出所は「IN条件」そのもの**なので、`material_rights_sources` は
`conditions WHERE direction='in'` のビューになる（現行は同じ事実を2箇所に持っている）。

### 2.3 合意と条件（コア）

```sql
CREATE TABLE agreements (                      -- 現 contracts
  id bigserial PRIMARY KEY,
  agreement_no text UNIQUE,
  title text NOT NULL,
  counterparty_id bigint NOT NULL REFERENCES parties(id),
  direction text NOT NULL CHECK (direction IN ('in','out')),
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','negotiating','executed','expired','terminated')),
  executed_on date, effective_on date, expires_on date,
  auto_renewal boolean NOT NULL DEFAULT false,
  renewal_notice_months int,
  source_system text, source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conditions (                      -- 現 condition_lines（44列 → 30列）
  id bigserial PRIMARY KEY,
  condition_no    text UNIQUE,                 -- CL-YYYY-NNNNN
  agreement_id    bigint REFERENCES agreements(id),
  parent_id       bigint REFERENCES conditions(id),   -- IN条件 → OUT条件の連鎖
  direction       text NOT NULL CHECK (direction IN ('in','out')),   -- ★向きは1列
  kind            text NOT NULL
                  CHECK (kind IN ('license','product','service','expense','fee')),
  name            text NOT NULL,
  counterparty_id bigint NOT NULL REFERENCES parties(id),
  work_id         bigint REFERENCES works(id),
  work_part_id    bigint REFERENCES work_parts(id),

  exclusivity     text CHECK (exclusivity IN ('exclusive','non_exclusive')),
  sublicensable   boolean,
  term_start      date, term_end date,

  currency        char(3) NOT NULL DEFAULT 'JPY',
  pricing_model   text NOT NULL
                  CHECK (pricing_model IN ('fixed','unit_rate','revenue_rate','subscription','none')),
  rate_ppm        integer,        -- 料率＝百万分率の整数（12.5% → 125000）
  unit_amount     bigint,         -- 最小通貨単位の整数
  flat_amount     bigint,
  mg_amount       bigint,         -- 最低保証（floor・消化しない）
  ag_amount       bigint,         -- 前払保証（累積消化）
  royalty_base    text,
  deductible_costs text,
  tax_category    text NOT NULL DEFAULT 'taxable'
                  CHECK (tax_category IN ('taxable','reduced','exempt')),
  withholding_note text,
  payment_terms   text, cycle text,

  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('draft','active','superseded','void')),
  superseded_by_id bigint REFERENCES conditions(id),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (work_part_id IS NULL OR work_id IS NOT NULL),
  CHECK (pricing_model <> 'unit_rate'    OR unit_amount IS NOT NULL),
  CHECK (pricing_model <> 'revenue_rate' OR rate_ppm    IS NOT NULL)
);

CREATE TABLE condition_scopes (                -- 地域・言語・媒体を1表に
  condition_id bigint NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
  scope_type text NOT NULL
             CHECK (scope_type IN ('region','language','media','channel')),
  code  text,                                  -- ISO 3166 / ISO 639
  label text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (condition_id, scope_type, label)
);
```

**消える列**（現 `condition_lines` 44列から）：
`flow_direction` / `is_inbound`（`direction` に統合）、
`region_territory` / `region_language`（`condition_scopes` に統合）、
`capability_id` / `legacy_role`（遺産）、
`source_work_id` / `source_material_id`（`work_id` / `work_part_id` に統合）、
`line_no` / `line_code` / `group_no`（文書側の並び順なので `document_conditions` へ移動）、
`document_id`（**向きを反転**・下記）、`payment_date`（実績なので `condition_events` へ）。

**`document_id` の反転が最大の変更点。** 現行は条件が文書に属するため、
再発行のたびに条件行を新版へ付け替える処理（`moveConditions`）が要る。
新設計では文書が条件を参照するので、**再発行しても条件は動かない**。

### 2.4 予定・実績・金銭

```sql
CREATE TABLE condition_schedules (             -- 現 condition_line_installments
  id bigserial PRIMARY KEY,
  condition_id bigint NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
  seq int NOT NULL,
  trigger_kind text NOT NULL,                  -- on_execution / on_delivery / on_inspection / periodic
  planned_amount bigint NOT NULL,
  due_on date,
  UNIQUE (condition_id, seq)
);

-- 現 condition_events / manufacturing_events / sales_events /
--    delivery_events / condition_receipts の5表を統合（統合前の実データは合計66行）
CREATE TABLE condition_events (
  id bigserial PRIMARY KEY,
  condition_id bigint NOT NULL REFERENCES conditions(id),
  schedule_id  bigint REFERENCES condition_schedules(id),
  event_type text NOT NULL CHECK (event_type IN
    ('manufacturing','sales','sublicense_receipt','inspection','delivery','adjustment')),
  occurred_on date NOT NULL,
  period      text,                            -- 2026H1 等
  quantity        numeric(14,4),
  sample_quantity numeric(14,4),
  gross_amount bigint,
  deductions   bigint NOT NULL DEFAULT 0,
  amount       bigint NOT NULL,                -- 条件通貨での確定額
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL
);

CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  payment_no text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  party_id bigint NOT NULL REFERENCES parties(id),
  currency char(3) NOT NULL,
  amount bigint NOT NULL,
  tax_amount bigint NOT NULL DEFAULT 0,
  withholding_amount bigint NOT NULL DEFAULT 0,  -- ★源泉を永続化（現行は導出のみ）
  fx_rate numeric(12,6),
  due_on date, paid_on date,
  status text NOT NULL CHECK (status IN ('planned','approved','paid','canceled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 支払 ↔ 条件/実績 の多対多。現行に相当物が無く、royalty_payments の
-- 「対応づかないレガシー行」問題はこの欠落が原因だった。
CREATE TABLE payment_allocations (
  payment_id bigint NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  condition_id bigint NOT NULL REFERENCES conditions(id),
  event_id bigint REFERENCES condition_events(id),
  amount bigint NOT NULL,
  PRIMARY KEY (payment_id, condition_id, event_id)
);
```

**廃止**：`royalty_payments`、`royalty_calculations`。
計算結果は「計算書＝文書」＋`condition_events` で表現でき、独立表を持つ必然性が無い
（本番0行で活性化した層＝統合コストが最も安い部分）。

```sql
CREATE TABLE statements (                      -- 現 royalty_statements
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  condition_id bigint NOT NULL REFERENCES conditions(id),
  period text NOT NULL,
  currency char(3) NOT NULL,
  gross_amount bigint NOT NULL, mg_topup bigint NOT NULL DEFAULT 0,
  ag_offset bigint NOT NULL DEFAULT 0, net_amount bigint NOT NULL,
  tax_amount bigint NOT NULL DEFAULT 0,
  UNIQUE (document_id)
);

CREATE TABLE statement_lines (                 -- 現 royalty_statement_lines（26列 → 13列）
  id bigserial PRIMARY KEY,
  statement_id bigint NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  condition_id bigint NOT NULL REFERENCES conditions(id),
  event_id bigint REFERENCES condition_events(id),
  product_name text,
  quantity numeric(14,4), sample_quantity numeric(14,4),
  unit_amount bigint, rate_ppm integer,
  sales_input bigint, fx_rate numeric(12,6),
  amount bigint NOT NULL,
  UNIQUE (statement_id, line_no)
);
```

現行 `royalty_statement_lines` の `document_number` / `backlog_issue_key` / `contract_id` /
`contract_title` / `contract_number` は**すべて `condition_id` から辿れる非正規化列**なので削除。

### 2.5 文書

```sql
CREATE TABLE document_templates (
  id bigserial PRIMARY KEY, template_key text UNIQUE NOT NULL,
  label text NOT NULL, category text, number_prefix text,
  current_version_id bigint, is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE document_template_versions (
  id bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  html_source text NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 変数名・型・必須・条件からの導出元
  UNIQUE (template_id, version_no)
);

CREATE TABLE documents (
  id bigserial PRIMARY KEY,
  document_no text UNIQUE,
  template_version_id bigint NOT NULL REFERENCES document_template_versions(id),
  matter_id    bigint REFERENCES matters(id),
  agreement_id bigint REFERENCES agreements(id),
  status text NOT NULL DEFAULT 'draft'
         CHECK (status IN ('draft','issued','superseded','void')),   -- ★NULLなし
  supersedes_id bigint REFERENCES documents(id),
  -- 出力時点の確定値。テンプレ変数名をキーとする読取専用スナップショット。
  -- 業務データの参照元にはしない（＝現行 form_data の役割を剥奪する）。
  rendered_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  manual_inputs   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 条件から導出できない手入力のみ
  storage_url text,
  issued_at timestamptz, issued_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 文書が出力した条件（現行の逆向き）。並び順は文書側の属性。
CREATE TABLE document_conditions (
  document_id  bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  condition_id bigint NOT NULL REFERENCES conditions(id),
  line_no int NOT NULL,
  PRIMARY KEY (document_id, condition_id)
);

CREATE TABLE document_sequences (
  prefix text NOT NULL, year int NOT NULL,
  current_value int NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);
```

**`documents` は36列 → 12列。** 廃止するのは `contracts` と重複する12列
（`contract_title` / `contract_status` / `contract_category` / `contract_type` /
`effective_date` / `expiration_date` / `auto_renewal` / `renewal_notice_months` /
`scope` / `source_system` / `document_url` / `record_type`）と、
スナップショット9列（`work_name` / `original_work` / `product_name` /
`vendor_name_snapshot` / `amount_ex_tax` / `amount_inc_tax` / `due_date` /
`flow_direction` / `alert_lead_months`）。**すべて `agreement_id` / `document_conditions` 経由で解決できる。**

### 2.6 業務フロー

```sql
CREATE TABLE matters (
  id bigserial PRIMARY KEY, matter_no text UNIQUE,
  title text NOT NULL,
  -- フロー種別＝制御列。必須項目・検査・使えるテンプレートをこれが決める（§2.9）。
  kind text NOT NULL DEFAULT 'single'
       CHECK (kind IN ('work', 'outsourcing', 'single')),
  status text NOT NULL CHECK (status IN ('open','waiting','blocked','done','canceled')),
  owner_staff_id bigint REFERENCES staff(id),
  counterparty_id bigint REFERENCES parties(id),
  requester_email text, requester_slack_id text,
  due_on date, blocked_reason text, remarks text,
  drive_folder_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- 現 matter_issues ＋ 文書紐付け ＋ Slackスレッド ＋ 依頼を1表に
CREATE TABLE matter_links (
  id bigserial PRIMARY KEY,
  matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  target_type text NOT NULL
              CHECK (target_type IN ('backlog_issue','document','agreement','condition','slack_thread')),
  target_ref text NOT NULL,                    -- 課題キー / ID / thread_ts
  relation text NOT NULL DEFAULT 'related',
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (matter_id, target_type, target_ref)
);

CREATE TABLE tasks (
  id bigserial PRIMARY KEY,
  matter_id bigint NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
  title text NOT NULL, task_type text,
  assignee_staff_id bigint REFERENCES staff(id),
  due_at timestamptz,
  status text NOT NULL CHECK (status IN ('todo','doing','blocked','done')),
  blocked_reason text
);
```

**廃止**：`legal_requests`（`matters` ＋ `matter_links` に統合。
**「依頼INSERT → トリガで案件生成」という暗黙の副作用が消え、案件がアプリの明示的な生成物になる**）、
`issue_workflows`（`matter_links.snapshot`）、`matter_issues`、`document_sends`（監査へ）。

### 2.7 運用（`lb_v2_*` 12表 → 1表）

```sql
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT current_user,
  action text NOT NULL,        -- document.issue / document.void / document.reissue /
                               -- slack.notify / cloudsign.request / gmail.send /
                               -- excel.export / webhook.receive / job.alert …
  target_type text NOT NULL, target_id bigint,
  idempotency_key text UNIQUE, -- 冪等キーの一元化（現行は5表が個別に持つ）
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;

CREATE TABLE settings ( key text PRIMARY KEY, value jsonb NOT NULL,
                        updated_at timestamptz NOT NULL DEFAULT now(), updated_by text );
CREATE TABLE snippets ( id bigserial PRIMARY KEY, category text NOT NULL, title text NOT NULL,
                        body text NOT NULL, sort_order int NOT NULL DEFAULT 0,
                        is_active boolean NOT NULL DEFAULT true );
CREATE TABLE data_quality_issues ( id bigserial PRIMARY KEY, rule_code text NOT NULL,
                        target_type text NOT NULL, target_id bigint NOT NULL,
                        status text NOT NULL DEFAULT 'open', detected_at timestamptz NOT NULL DEFAULT now(),
                        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
                        UNIQUE (rule_code, target_type, target_id) );
```

**廃止**：`department_workflow_rules`（`settings` のキー1本）、`document_number_history`（`audit_events`）。

### 2.8 ビュー（派生値はここに集約）

```sql
CREATE VIEW v_condition_balance AS   -- MG/AG消化・残高・消化率
CREATE VIEW v_document_display AS    -- 件名・相手先の解決を1箇所に（キー乱立の代替）
CREATE VIEW v_deadlines AS           -- 依頼・契約満了・納品・支払を統合
CREATE VIEW v_rights_sources AS      -- conditions WHERE direction='in'（現 material_rights_sources）
CREATE VIEW v_work_rights_envelope AS -- 作品ごとに「許諾できる上限」（§2.9）
```

### 2.9 運用モデル（案件の位置づけと3層）

物理の軸は条件だが、**運用の軸は別**である。この二つを混同すると画面も権限も破綻する。

#### 案件は制御レイヤー、所有レイヤーではない

作業はすべて案件から入る。案件の `kind`（フロー種別）が、必須項目・検査・使えるテンプレートを決める。

| フロー種別 | 対象 | 段階 |
|---|---|---|
| `work` 作品フロー | 権利の取得と展開 | 上限確認 → 条件合意 → 契約書 → 実績 → 計算書と分配 |
| `outsourcing` 業務委託フロー | 制作の発注 | 基本契約 → 発注 → 納品 → 検収 → 支払 |
| `single` 単発フロー | NDA・通知書・法務相談 | 受付 → ひな形選定 → 締結 → 完了 |

`single` は**条件を持たない案件**である。金銭条件も権利の移動も伴わない案件が実運用の1〜2割を占めるため、
条件を必須にしない設計が要る。

ただし**案件は条件・作品・取引先を所有しない**。これらは案件より寿命が長いからである。

| | 案件 | 条件・作品・取引先 |
|---|---|---|
| 役割 | 制御（入口・種別・必須項目・検査） | 実体 |
| 関係 | `matter_links` で束ねる（参照） | 束ねられる |
| 案件完了後 | 閉じる | 残る |

所有にできない理由は具体的である。ある作品の挿絵の取得は案件A、繁体字許諾は案件B、
グッズ許諾は案件Cで起きる。**「この作品で許諾できる上限」はこの3案件を横断しないと計算できない**。
支払も同様で、1回の振込が複数案件の実績をまとめることがある。

#### 合意・条件・実績の3層

```
agreements   合意（器）      … 相手先・契約期間・自動更新・更新通告・契約書
  conditions 条件（中身）    … 金額・範囲・税区分・支払サイクル・有効期間
    condition_events 実績    … 期間経過・納品・販売・入金
```

分ける理由は**変わる頻度が違う**こと。契約は続いたまま金額だけが改定されるのが普通で、
そのとき合意はそのまま、条件だけが `superseded_by_id` で世代交代する。

```
AGR-2024-0117  顧問契約書（自動更新・3か月前通告）2024-04 〜
├ CL-2024-00050  月額10万                2024-04 〜 2026-03  [改訂済]
├ CL-2026-00077  月額12万                2026-04 〜          [有効]
└ CL-2026-00078  実費精算（kind=expense）2026-04 〜          [有効]
```

1つの合意に複数の条件がぶら下がるのも普通である（顧問料・スポット単価・実費は税区分も支払サイクルも違う）。
個別の相談は案件として起こし、`matter_links` から**条件**を参照する（合意ではない。
どの世代の条件を消化したのかが要るため）。

#### 作品の権利包絡

OUT条件の照合は、個々のIN条件ではなく**構成パート全部のIN条件の積**に対して行う。

```sql
CREATE VIEW v_work_rights_envelope AS ...
-- 作品ごとに、地域・言語・媒体・期間・独占・再許諾の各次元について
-- 取得済みIN条件の積（＝許諾できる上限）と、その次元を狭めている条件IDを返す。
```

個々のIN条件と照合すると誤判定する。本文の取得条件が商品化まで含んでいても、
挿絵の取得条件が出版・電子配信までなら、**作品としては商品化できない**。
「本文の範囲内だから通す」を防ぐには積で見る必要がある。

#### 成果物を伴わない役務（顧問・コンサル・保守）

追加の列も種別も要らない。`kind='service'` の条件を1行持ち、
**支払の起点だけを `condition_schedules.trigger_kind` で区別する**。

| | trigger_kind | 支払の起点 |
|---|---|---|
| 成果物ありの業務委託 | `on_inspection` | 検収 |
| 顧問・コンサル・保守 | `periodic` | 期間の経過 |

案件のフロー種別は `outsourcing` を流用し、`periodic` のときは納品・検収の段階を出さない。
相手先が個人のときの支払期日の検査は、条件として持っている以上そのまま効く（追加実装は不要）。

込み枠と超過（月5時間まで、超過は時間単価）および業務範囲の照合は**現段階では対象外**とする。
必要になった時点で `conditions` に `included_quantity` と `recurrence` を足し、
`condition_scopes.scope_type` に `service` を加えれば足りる。


---

## 3. 現行との対応表

| 現行 | 新 | 変化 |
|---|---|---|
| `vendors`(19列) | `parties` ＋ `party_contacts` ＋ `party_bank_accounts` | 機微情報を表分離。名寄せは `merged_into_id` |
| `staff` | `staff` | ほぼ同じ |
| `works` ＋ `source_ips` | `works` | 統合（`kind` で区別） |
| `work_materials` | `work_parts` | 17列 → 6列 |
| `material_categories` / `material_rights_sources` / `work_material_uses` | **廃止**（ビュー化） | 権利の出所＝IN条件 |
| `work_relations` ＋ `works.parent_work_id` | `work_lineage` | 二重表現を解消 |
| `contracts` ＋ `contract_works` | `agreements` | 作品紐付けは条件が持つ |
| **`condition_lines`(44列)** | **`conditions`(30列)** | 向き3→1、地域言語→`condition_scopes`、`document_id` 反転 |
| `condition_line_regions` / `_languages` | `condition_scopes` | 2表→1表・媒体等に拡張可 |
| `condition_line_installments` | `condition_schedules` | 同じ |
| `condition_events` ＋ `manufacturing_events` ＋ `sales_events` ＋ `delivery_events` ＋ `condition_receipts` | `condition_events` | **5表→1表** |
| `payments` ＋ `royalty_payments` | `payments` ＋ `payment_allocations` | 多対多を導入・レガシー表を吸収 |
| `royalty_calculations` | **廃止** | 文書＋イベントで表現 |
| `royalty_statements` / `_lines` | `statements` / `statement_lines` | 非正規化列を削除（26→13列） |
| **`documents`(36列)** | **`documents`(12列)** ＋ `document_conditions` | 契約業務列12・スナップショット9を廃止 |
| `document_drafts` | `documents`(status='draft') | 別表をやめる |
| `document_number_history` / `document_sends` | `audit_events` | 統合 |
| `matters` / `matter_issues` / `matter_tasks` / `legal_requests` / `issue_workflows` | `matters` / `matter_links` / `tasks` | **5表→3表**。トリガ廃止。`matters.kind` が制御列になる（§2.9） |
| `lb_v2_*` 12表 | `audit_events` | **12表→1表** |
| `app_settings` / `department_workflow_rules` | `settings` | 統合 |

**約50リレーション → 27テーブル ＋ 4ビュー。**

---

## 4. これで何が構造的に解決するか

| 現行の問題 | 新設計での解消理由 |
|---|---|
| 許諾範囲の判定が甘い | 個々のIN条件ではなく作品の権利包絡（積）と照合する |
| 条件を持たない案件の居場所がない | `matters.kind='single'` として種別のひとつになる |
| 編集が一部にしか効かない | 事実の保存先が1箇所。ファンアウトが存在しない |
| `documents.contract_title` を直せない | 列自体が無い。件名は `agreements.title` の1箇所 |
| 相手先が10種のキーで散る | `conditions.counterparty_id` の1箇所。テンプレ変数は出力時のバインドのみ |
| 条件の金額を直せない | `conditions` への通常のUPDATE。実績がある行は `superseded_by_id` で改訂 |
| 再発行で条件を付け替える必要 | 文書→条件の参照なので条件は動かない |
| `lifecycle_status` NULL の判定漏れ | `status` は NOT NULL ＋ CHECK |
| 取引先名寄せが9表更新 | `merged_into_id` の1行更新 |
| レガシー支払が紐づかない | `payment_allocations` で多対多を表現 |
| MG/AG の丸め事故 | 金額 bigint（最小通貨単位）＋料率 ppm 整数 |
| 監査台帳が12表に分散 | `audit_events` 1表・冪等キーも一元化 |

---

## 5. 何を失うか（正直な代償）

1. **V1が動かなくなる。** 同一DBを共有できないため、V1停止が着手の前提条件になる。
   V1のトリガ（`legal_requests`→`matters`、`tg_doc_autolink_contract`）に依存した運用も止まる。
2. **Handlebarsテンプレ本文と `field_schema` の互換が切れる。**
   `rendered_values` に旧変数名でバインドを残せば本文は維持できるが、
   変数の**供給元**が `form_data` から条件・当事者・作品に変わるため、
   テンプレごとにマッピング表を作る必要がある（現行のテンプレ数ぶんの作業）。
3. **Backlog連携キーの持ち方が変わる。** `backlog_issue_key` が
   `documents` / `condition_lines` / `payments` 等に散在していたのを `matter_links` に集約するため、
   Backlog側の運用（互換境界の4項目め）との突き合わせが要る。
4. **`form_data` の考古学を一度で完了させる必要がある。**
   現行は「読むときにフォールバック」で逃げているが、新設計では変換時に全件確定させる。
   相手先10キー・件名6キーの解決を、**移行スクリプトで決め切らねばならない**。
   ここが移行の最難関で、決められない行は `data_quality_issues` に落として人手で潰す。

---

## 6. 移行手順

| Phase | 内容 | 目安 |
|---|---|---|
| 0 | 新DB（別インスタンス）を立てDDL適用。V1は現行DBのまま稼働 | 1週 |
| 1 | 変換スクリプト（現行→新・冪等・再実行可能）。データ量は小さい（`matters` 約218件／`legal_requests` 約466件／`payments` 25件／`condition_events` 66件）ので**一括変換が現実的** | 3〜4週 |
| 2 | 新アプリのコア（条件・文書・案件）を新スキーマで構築 | 6〜8週 |
| 3 | 外部連携（Slack / Gmail / CloudSign / Backlog / Drive）の移植。アダプタは現行から流用可 | 3〜4週 |
| 4 | 並行稼働（V1→新DBへ一方向同期）→ V1停止 → 切替 | 3〜4週 |

**合計 4〜5ヶ月（1〜2人）。** 前回提示した「コアモデルだけ組み直す」案（1〜1.5ヶ月）との差
**約3ヶ月が、この設計を手に入れる価格**になる。

移行スクリプトの要点：

```
vendors        → parties（trade_name/pen_name → aliases[]、bank列 → party_bank_accounts）
works+source_ips → works（kind で区別）
work_materials → work_parts
contracts      → agreements
condition_lines→ conditions
   direction   : flow_direction ?? (direction='receivable' ? 'out' : 'in') ?? is_inbound
   work_id     : work_id ?? source_material_id→work ?? source_work_id ?? form_data.work_code
   scopes      : condition_line_regions/languages があればそれ、無ければテキスト列を分解
   金額         : numeric → bigint（最小通貨単位・切り上げ規則は現行の Math.ceil に合わせる）
   rate_pct    → rate_ppm = round(rate_pct * 10000)
documents      → documents ＋ agreements（契約業務列から合意を復元）＋ document_conditions
   rendered_values : form_data をテンプレ変数名のままコピー（本文互換のため）
   相手先・件名     : 10キー/6キーの解決表で確定 → 決まらない行は data_quality_issues
legal_requests → matters ＋ matter_links(backlog_issue)
lb_v2_* 12表   → audit_events（action にテーブル由来の種別を割り当て）
```

---

## 7. 判断材料

**この案を採るべき条件**

- V1停止の見通しが立つ（半年以内）
- 条件の編集・訂正が今後の運用で頻繁に発生する
- 金銭計算（MG/AG・源泉・為替）を本格運用する予定がある

**採るべきでない条件**

- V1停止の時期が読めない → 二重管理期間が長期化し、最悪の状態になる
- 直近で本番切替を急ぐ必要がある → 現行の互換境界のまま進めるほうが速い

中間案として、**「コアモデルだけ組み直す」を先に1〜1.5ヶ月で実施し、
その書込アダプタの下だけを後から新スキーマに差し替える**進め方も取れる。
アダプタ層が挟まっていれば、本案への移行は Phase 1 と Phase 4 だけになり、
アプリの作り直し（Phase 2・3）が不要になる。**これが最も損の少ない順序**。
