-- =====================================================================
-- LegalBridge V3 スキーマ
--   docs/core-schema-redesign.md の設計を実装する。
--   既存の public スキーマには一切触れない（V1・V2 は稼働したまま）。
--   作り直しは DROP SCHEMA v3 CASCADE; で完結する。
--
--   実行: psql "$ADMIN_DSN" -f infra/v3/001_schema.sql
--   前提: 実行ロールが CREATE SCHEMA 権限を持つこと。
--
--   規約
--     金額  : bigint（最小通貨単位の整数）。JPY なら円。
--     料率  : integer（百万分率 ppm）。12.5% → 125000。
--     状態  : NOT NULL + CHECK。NULL を状態として使わない。
--     向き  : direction は in / out の1列だけ。payable/receivable は導出。
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

CREATE SCHEMA IF NOT EXISTS v3;
COMMENT ON SCHEMA v3 IS 'LegalBridge V3。条件を軸にした再設計スキーマ（docs/core-schema-redesign.md）。';

SET LOCAL search_path = v3, public;

-- ---------------------------------------------------------------------
-- 1. 当事者
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.parties (
  id             bigserial PRIMARY KEY,
  party_code     text UNIQUE,
  kind           text NOT NULL CHECK (kind IN ('corporate', 'individual')),
  name           text NOT NULL,
  name_kana      text,
  aliases        text[] NOT NULL DEFAULT '{}',   -- 屋号・ペンネーム・旧称
  invoice_no     text,
  corporate_no   text,
  withholding    boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'archived', 'merged')),
  merged_into_id bigint REFERENCES v3.parties(id),
  legacy_id      integer,                        -- 移行元 public.vendors.id
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
COMMENT ON COLUMN v3.parties.aliases IS
  '別名。統合しても参照は付け替えず merged_into_id を辿って解決する。';
CREATE INDEX IF NOT EXISTS parties_name_idx    ON v3.parties (name);
CREATE INDEX IF NOT EXISTS parties_aliases_idx ON v3.parties USING gin (aliases);
CREATE UNIQUE INDEX IF NOT EXISTS parties_legacy_uq ON v3.parties (legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS v3.party_contacts (
  id         bigserial PRIMARY KEY,
  party_id   bigint NOT NULL REFERENCES v3.parties(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('primary', 'signer', 'billing')),
  name       text,
  email      text,
  phone      text,
  department text,
  UNIQUE (party_id, role)
);

-- 機微情報は表を分ける。列レベル GRANT が不要になり表単位で隔離できる。
CREATE TABLE IF NOT EXISTS v3.party_bank_accounts (
  party_id            bigint PRIMARY KEY REFERENCES v3.parties(id) ON DELETE CASCADE,
  bank_name           text,
  branch_name         text,
  account_type        text,
  account_number      text,
  account_holder_kana text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE v3.party_bank_accounts IS '口座情報。既定では runtime ロールに GRANT しない。';

CREATE TABLE IF NOT EXISTS v3.staff (
  id            bigserial PRIMARY KEY,
  staff_code    text UNIQUE,
  name          text NOT NULL,
  email         text UNIQUE,
  department    text,
  slack_user_id text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  legacy_id     integer
);

-- ---------------------------------------------------------------------
-- 2. 作品
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.works (
  id            bigserial PRIMARY KEY,
  work_code     text UNIQUE,
  title         text NOT NULL,
  title_kana    text,
  kind          text NOT NULL DEFAULT 'own'
                CHECK (kind IN ('own', 'source_ip', 'derivative')),
  business_line text,
  status        text NOT NULL DEFAULT 'planning'
                CHECK (status IN ('planning', 'in_production', 'released', 'archived')),
  remarks       text,
  legacy_id     integer,
  legacy_table  text CHECK (legacy_table IN ('works', 'source_ips')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS works_title_idx ON v3.works (title);
CREATE UNIQUE INDEX IF NOT EXISTS works_legacy_uq
  ON v3.works (legacy_table, legacy_id) WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS v3.work_parts (
  id              bigserial PRIMARY KEY,
  work_id         bigint NOT NULL REFERENCES v3.works(id) ON DELETE CASCADE,
  part_no         int NOT NULL,
  name            text NOT NULL,
  part_type       text NOT NULL,
  royalty_bearing boolean NOT NULL DEFAULT true,
  remarks         text,
  legacy_id       integer,
  -- 移行で採番し直すことがあるため遅延可能にする。1文の途中で番号が
  -- すれ違っても、COMMIT 時に最終状態が一意なら通る。
  CONSTRAINT work_parts_work_part_uq UNIQUE (work_id, part_no) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE v3.work_parts IS '作品の構成要素（現 work_materials）。権利の上限はパートの取得条件の積で決まる。';

CREATE TABLE IF NOT EXISTS v3.work_lineage (
  parent_work_id bigint NOT NULL REFERENCES v3.works(id) ON DELETE CASCADE,
  child_work_id  bigint NOT NULL REFERENCES v3.works(id) ON DELETE CASCADE,
  relation_type  text NOT NULL,
  PRIMARY KEY (parent_work_id, child_work_id, relation_type),
  CHECK (parent_work_id <> child_work_id)
);

-- ---------------------------------------------------------------------
-- 3. 案件（制御レイヤー）
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.matters (
  id                 bigserial PRIMARY KEY,
  matter_no          text UNIQUE,
  title              text NOT NULL,
  -- フロー種別＝制御列。必須項目・検査・使えるテンプレートをこれが決める。
  kind               text NOT NULL DEFAULT 'single'
                     CHECK (kind IN ('work', 'outsourcing', 'single')),
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'waiting', 'blocked', 'done', 'canceled')),
  -- 進め方。取引モデルだけでは「実際に何をするか」が決まらない。
  document_style     text CHECK (document_style IS NULL OR document_style IN
                     ('counterparty_review', 'own_draft', 'own_template')),
  owner_staff_id     bigint REFERENCES v3.staff(id),
  counterparty_id    bigint REFERENCES v3.parties(id),
  requester_email    text,
  requester_slack_id text,
  due_on             date,
  blocked_reason     text,
  remarks            text,
  drive_folder_url   text,
  legacy_id          integer,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL)
);
COMMENT ON COLUMN v3.matters.kind IS
  'work=作品フロー / outsourcing=業務委託フロー（顧問・保守も含む）/ single=条件を持たない案件。';
CREATE INDEX IF NOT EXISTS matters_status_idx ON v3.matters (status, due_on);

-- 案件は参照するだけで所有しない。条件・作品・取引先は案件より寿命が長い。
CREATE TABLE IF NOT EXISTS v3.matter_links (
  id          bigserial PRIMARY KEY,
  matter_id   bigint NOT NULL REFERENCES v3.matters(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN
              ('backlog_issue', 'document', 'agreement', 'condition', 'payment',
               'slack_thread', 'email_thread')),
  target_ref  text NOT NULL,
  relation    text NOT NULL DEFAULT 'related',
  snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (matter_id, target_type, target_ref)
);

CREATE TABLE IF NOT EXISTS v3.tasks (
  id                bigserial PRIMARY KEY,
  matter_id         bigint NOT NULL REFERENCES v3.matters(id) ON DELETE CASCADE,
  title             text NOT NULL,
  task_type         text,
  description       text,
  assignee_staff_id bigint REFERENCES v3.staff(id),
  due_at            timestamptz,
  status            text NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  blocked_reason    text,
  legacy_id         integer
);

-- ---------------------------------------------------------------------
-- 4. 合意と条件（コア）
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.agreements (
  id                    bigserial PRIMARY KEY,
  agreement_no          text UNIQUE,
  title                 text NOT NULL,
  counterparty_id       bigint NOT NULL REFERENCES v3.parties(id),
  direction             text NOT NULL CHECK (direction IN ('in', 'out')),
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'negotiating', 'executed', 'expired', 'terminated')),
  executed_on           date,
  effective_on          date,
  expires_on            date,
  auto_renewal          boolean NOT NULL DEFAULT false,
  renewal_notice_months int,
  source_system         text,
  source_url            text,
  legacy_id             integer,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR effective_on IS NULL OR expires_on >= effective_on)
);
COMMENT ON TABLE v3.agreements IS
  '合意の器。契約は続いたまま金額だけ改定されるため、期間・更新は合意、金額は条件に置く。';

CREATE TABLE IF NOT EXISTS v3.conditions (
  id               bigserial PRIMARY KEY,
  condition_no     text UNIQUE,
  agreement_id     bigint REFERENCES v3.agreements(id),
  parent_id        bigint REFERENCES v3.conditions(id),   -- IN条件 → OUT条件の連鎖
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  kind             text NOT NULL
                   CHECK (kind IN ('license', 'product', 'service', 'expense', 'fee')),
  name             text NOT NULL,
  counterparty_id  bigint NOT NULL REFERENCES v3.parties(id),
  work_id          bigint REFERENCES v3.works(id),
  work_part_id     bigint REFERENCES v3.work_parts(id),

  exclusivity      text CHECK (exclusivity IN ('exclusive', 'non_exclusive')),
  sublicensable    boolean,
  term_start       date,
  term_end         date,

  currency         char(3) NOT NULL DEFAULT 'JPY',
  pricing_model    text NOT NULL DEFAULT 'none'
                   CHECK (pricing_model IN ('fixed', 'unit_rate', 'revenue_rate', 'subscription', 'none')),
  rate_ppm         integer CHECK (rate_ppm IS NULL OR rate_ppm BETWEEN 0 AND 1000000),
  unit_amount      bigint,
  flat_amount      bigint,
  mg_amount        bigint,   -- 最低保証。毎期独立の下限で、消化しない。
  ag_amount        bigint,   -- 前払保証。累積で充当する。
  royalty_base     text,
  deductible_costs text,
  tax_category     text NOT NULL DEFAULT 'taxable'
                   CHECK (tax_category IN ('taxable', 'reduced', 'exempt')),
  withholding_note text,
  payment_terms    text,
  cycle            text,

  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft', 'active', 'superseded', 'void')),
  superseded_by_id bigint REFERENCES v3.conditions(id),
  notes            text,
  legacy_id        integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CHECK (work_part_id IS NULL OR work_id IS NOT NULL),
  CHECK (term_end IS NULL OR term_start IS NULL OR term_end >= term_start),
  CHECK (pricing_model <> 'unit_rate'    OR unit_amount IS NOT NULL),
  CHECK (pricing_model <> 'revenue_rate' OR rate_ppm    IS NOT NULL),
  CHECK (pricing_model <> 'fixed'        OR flat_amount IS NOT NULL),
  CHECK (status <> 'superseded' OR superseded_by_id IS NOT NULL),
  CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
COMMENT ON COLUMN v3.conditions.direction IS '向きはこの1列だけ。payable/receivable は導出する。';
COMMENT ON COLUMN v3.conditions.rate_ppm  IS '百万分率の整数。12.5% → 125000。';
CREATE INDEX IF NOT EXISTS conditions_work_idx    ON v3.conditions (work_id) WHERE work_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conditions_party_idx   ON v3.conditions (counterparty_id);
CREATE INDEX IF NOT EXISTS conditions_parent_idx  ON v3.conditions (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conditions_active_idx  ON v3.conditions (direction, status);
CREATE UNIQUE INDEX IF NOT EXISTS conditions_legacy_uq
  ON v3.conditions (legacy_id) WHERE legacy_id IS NOT NULL;

-- 地域・言語・媒体を1表に。scope_type ごとに行が無ければ「無制限」を意味する。
CREATE TABLE IF NOT EXISTS v3.condition_scopes (
  condition_id bigint NOT NULL REFERENCES v3.conditions(id) ON DELETE CASCADE,
  scope_type   text NOT NULL CHECK (scope_type IN ('region', 'language', 'media', 'channel')),
  code         text,
  label        text NOT NULL,
  sort_order   int NOT NULL DEFAULT 0,
  PRIMARY KEY (condition_id, scope_type, label)
);
COMMENT ON TABLE v3.condition_scopes IS
  'scope_type の行が1件も無ければ、その次元は無制限（全世界・全言語など）と解釈する。';

-- ---------------------------------------------------------------------
-- 5. 予定と実績
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.condition_schedules (
  id             bigserial PRIMARY KEY,
  condition_id   bigint NOT NULL REFERENCES v3.conditions(id) ON DELETE CASCADE,
  seq            int NOT NULL,
  -- 支払の起点。成果物ありの業務委託は on_inspection、顧問・保守は periodic。
  trigger_kind   text NOT NULL CHECK (trigger_kind IN
                 ('on_execution', 'on_delivery', 'on_inspection', 'periodic')),
  planned_amount bigint NOT NULL,
  due_on         date,
  -- 明細行の名前。「2026年4月分」「第1回 着手金」など。
  label          text,
  legacy_id      integer,
  CONSTRAINT condition_schedules_seq_uq UNIQUE (condition_id, seq) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON COLUMN v3.condition_schedules.trigger_kind IS
  '何をもって支払が発生するか。periodic は成果物を伴わない役務（顧問・コンサル・保守）。';

-- 現 condition_events / manufacturing_events / sales_events /
--    delivery_events / condition_receipts を統合した1表。
CREATE TABLE IF NOT EXISTS v3.condition_events (
  id              bigserial PRIMARY KEY,
  condition_id    bigint NOT NULL REFERENCES v3.conditions(id),
  schedule_id     bigint REFERENCES v3.condition_schedules(id),
  event_type      text NOT NULL CHECK (event_type IN
                  ('manufacturing', 'sales', 'sublicense_receipt', 'inspection',
                   'delivery', 'service_period', 'adjustment')),
  occurred_on     date NOT NULL,
  period          text,
  quantity        numeric(14,4),
  sample_quantity numeric(14,4),
  gross_amount    bigint,
  deductions      bigint NOT NULL DEFAULT 0,
  amount          bigint NOT NULL,
  document_id     bigint,   -- FK は documents 作成後に付与
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  note            text,
  legacy_id       integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT current_user
);
CREATE INDEX IF NOT EXISTS condition_events_cond_idx ON v3.condition_events (condition_id, occurred_on);
CREATE INDEX IF NOT EXISTS condition_events_type_idx ON v3.condition_events (event_type, occurred_on);

-- ---------------------------------------------------------------------
-- 6. 金銭
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.payments (
  id                 bigserial PRIMARY KEY,
  payment_no         text UNIQUE,
  direction          text NOT NULL CHECK (direction IN ('in', 'out')),
  party_id           bigint NOT NULL REFERENCES v3.parties(id),
  currency           char(3) NOT NULL DEFAULT 'JPY',
  amount             bigint NOT NULL,
  tax_amount         bigint NOT NULL DEFAULT 0,
  withholding_amount bigint NOT NULL DEFAULT 0,
  fx_rate            numeric(12,6),
  -- 取適法の検査。受領日を起算点にした期日と、その根拠を残す。
  basis_received_on  date,
  due_on             date,
  paid_on            date,
  status             text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'approved', 'paid', 'canceled')),
  note               text,
  legacy_id          integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN v3.payments.basis_received_on IS
  '支払期日の起算日（給付を受領した日）。取適法の60日判定はこの列と due_on の差で行う。';
CREATE INDEX IF NOT EXISTS payments_due_idx ON v3.payments (status, due_on);

-- 支払 ↔ 条件・実績。現行に相当物が無く、紐づかないレガシー支払の原因だった。
CREATE TABLE IF NOT EXISTS v3.payment_allocations (
  id           bigserial PRIMARY KEY,
  payment_id   bigint NOT NULL REFERENCES v3.payments(id) ON DELETE CASCADE,
  condition_id bigint NOT NULL REFERENCES v3.conditions(id),
  -- どの実績に対する支払か。特定できないこともあるので NULL を許す。
  event_id     bigint REFERENCES v3.condition_events(id),
  amount       bigint NOT NULL CHECK (amount <> 0),
  -- 同じ組み合わせを二度割り当てない。NULLS NOT DISTINCT にしないと
  -- 実績を指定しない割り当てが何本でも入ってしまう。
  UNIQUE NULLS NOT DISTINCT (payment_id, condition_id, event_id)
);
COMMENT ON TABLE v3.payment_allocations IS
  '支払を条件へ割り当てる。1件の支払を複数条件に分けられる。合計は支払額を超えない。';

-- ---------------------------------------------------------------------
-- 7. 文書
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.document_templates (
  id                 bigserial PRIMARY KEY,
  template_key       text UNIQUE NOT NULL,
  label              text NOT NULL,
  category           text,
  number_prefix      text,
  current_version_id bigint,
  is_active          boolean NOT NULL DEFAULT true,
  legacy_id          integer
);

CREATE TABLE IF NOT EXISTS v3.document_template_versions (
  id          bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES v3.document_templates(id) ON DELETE CASCADE,
  version_no  int NOT NULL,
  html_source text NOT NULL,
  variables   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 変数名・型・必須・条件からの導出元
  comment     text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  legacy_id   integer,
  UNIQUE (template_id, version_no)
);

ALTER TABLE v3.document_templates
  DROP CONSTRAINT IF EXISTS document_templates_current_version_fk;
ALTER TABLE v3.document_templates
  ADD CONSTRAINT document_templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES v3.document_template_versions(id);

CREATE TABLE IF NOT EXISTS v3.documents (
  id                  bigserial PRIMARY KEY,
  document_no         text UNIQUE,
  -- 取込文書（既存契約書のPDF登録）はテンプレートを持たないため NULL を許す。
  template_version_id bigint REFERENCES v3.document_template_versions(id),
  matter_id           bigint REFERENCES v3.matters(id),
  agreement_id        bigint REFERENCES v3.agreements(id),
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'issued', 'superseded', 'void')),
  supersedes_id       bigint REFERENCES v3.documents(id),
  -- 出力時点の確定値。読み取り専用の記録で、業務データの参照元にはしない。
  rendered_values     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 条件から導出できない手入力だけ。
  manual_inputs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_url         text,
  issued_at           timestamptz,
  issued_by           text,
  legacy_id           integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'issued' OR document_no IS NOT NULL),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
COMMENT ON COLUMN v3.documents.rendered_values IS
  '発行時点のスナップショット。相手先・件名・期間はここではなく条件と合意から解決する。';
CREATE INDEX IF NOT EXISTS documents_matter_idx ON v3.documents (matter_id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_legacy_uq
  ON v3.documents (legacy_id) WHERE legacy_id IS NOT NULL;

ALTER TABLE v3.condition_events
  DROP CONSTRAINT IF EXISTS condition_events_document_fk;
ALTER TABLE v3.condition_events
  ADD CONSTRAINT condition_events_document_fk
  FOREIGN KEY (document_id) REFERENCES v3.documents(id);

-- 文書が条件を参照する（現行の逆向き）。再発行しても条件は動かない。
CREATE TABLE IF NOT EXISTS v3.document_conditions (
  document_id  bigint NOT NULL REFERENCES v3.documents(id) ON DELETE CASCADE,
  condition_id bigint NOT NULL REFERENCES v3.conditions(id),
  line_no      int NOT NULL,
  PRIMARY KEY (document_id, condition_id),
  CONSTRAINT document_conditions_line_uq UNIQUE (document_id, line_no) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS v3.document_sequences (
  prefix        text NOT NULL,
  year          int NOT NULL,
  current_value int NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, year)
);

-- ---------------------------------------------------------------------
-- 8. 計算書
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS v3.statements (
  id           bigserial PRIMARY KEY,
  document_id  bigint NOT NULL UNIQUE REFERENCES v3.documents(id) ON DELETE CASCADE,
  condition_id bigint NOT NULL REFERENCES v3.conditions(id),
  period       text NOT NULL,
  currency     char(3) NOT NULL DEFAULT 'JPY',
  gross_amount bigint NOT NULL,
  mg_topup     bigint NOT NULL DEFAULT 0,
  ag_offset    bigint NOT NULL DEFAULT 0,
  net_amount   bigint NOT NULL,
  tax_amount   bigint NOT NULL DEFAULT 0,
  legacy_id    integer
);

CREATE TABLE IF NOT EXISTS v3.statement_lines (
  id              bigserial PRIMARY KEY,
  statement_id    bigint NOT NULL REFERENCES v3.statements(id) ON DELETE CASCADE,
  line_no         int NOT NULL,
  condition_id    bigint NOT NULL REFERENCES v3.conditions(id),
  event_id        bigint REFERENCES v3.condition_events(id),
  product_name    text,
  quantity        numeric(14,4),
  sample_quantity numeric(14,4),
  unit_amount     bigint,
  rate_ppm        integer,
  sales_input     bigint,
  fx_rate         numeric(12,6),
  amount          bigint NOT NULL,
  legacy_id       integer,
  UNIQUE (statement_id, line_no)
);

-- ---------------------------------------------------------------------
-- 9. 運用
-- ---------------------------------------------------------------------

-- lb_v2_* 12表を統合した追記専用ログ。
CREATE TABLE IF NOT EXISTS v3.audit_events (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL DEFAULT current_user,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       bigint,
  idempotency_key text UNIQUE,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE v3.audit_events IS
  '追記専用。document.issue / slack.notify / cloudsign.request / gmail.send /
   excel.export / webhook.receive / job.alert / compliance.deviation などを1本に集約する。';
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON v3.audit_events (target_type, target_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON v3.audit_events (action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS v3.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS v3.snippets (
  id         bigserial PRIMARY KEY,
  category   text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS v3.data_quality_issues (
  id          bigserial PRIMARY KEY,
  rule_code   text NOT NULL,
  target_type text NOT NULL,
  target_id   bigint NOT NULL,
  severity    text NOT NULL DEFAULT 'medium' CHECK (severity IN ('high', 'medium', 'low')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (rule_code, target_type, target_id)
);

-- ---------------------------------------------------------------------
-- 10. 移行キー
--   各表の legacy_id は移行スクリプトの冪等キー（ON CONFLICT の対象）。
--   切替が完了し public を落とす際にまとめて削除できる。
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS staff_legacy_uq        ON v3.staff (legacy_id)               WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS work_parts_legacy_uq   ON v3.work_parts (legacy_id)          WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS matters_legacy_uq      ON v3.matters (legacy_id)             WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_legacy_uq        ON v3.tasks (legacy_id)               WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agreements_legacy_uq   ON v3.agreements (legacy_id)          WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cond_sched_legacy_uq   ON v3.condition_schedules (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cond_events_legacy_uq  ON v3.condition_events (legacy_id)    WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_legacy_uq     ON v3.payments (legacy_id)            WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS doc_templates_legacy_uq ON v3.document_templates (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS doc_tpl_ver_legacy_uq  ON v3.document_template_versions (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS statements_legacy_uq   ON v3.statements (legacy_id)          WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stmt_lines_legacy_uq   ON v3.statement_lines (legacy_id)     WHERE legacy_id IS NOT NULL;

COMMIT;
