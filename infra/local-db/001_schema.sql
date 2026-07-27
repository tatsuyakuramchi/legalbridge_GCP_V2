-- ローカル開発専用。既存本番DBへ適用しない。
CREATE TABLE document_templates (
  id SERIAL PRIMARY KEY,
  template_key VARCHAR(60) UNIQUE NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'document',
  label TEXT,
  category VARCHAR(50),
  document_prefix VARCHAR(20),
  current_version_id INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_template_versions (
  id SERIAL PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  html_source TEXT NOT NULL,
  field_schema JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

ALTER TABLE document_templates
  ADD CONSTRAINT document_templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_template_versions(id);

CREATE TABLE document_drafts (
  id SERIAL PRIMARY KEY,
  issue_key TEXT NOT NULL,
  template_type TEXT NOT NULL,
  form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_number VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  UNIQUE (issue_key, template_type)
);

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  document_number VARCHAR(100) UNIQUE,
  issue_key VARCHAR(50) NOT NULL,
  template_type VARCHAR(50) NOT NULL,
  template_version_id INTEGER REFERENCES document_template_versions(id),
  form_data JSONB NOT NULL,
  drive_link TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by VARCHAR(255)
);

CREATE TABLE document_sequences (
  kind VARCHAR(50) NOT NULL,
  year INTEGER NOT NULL,
  current_value INTEGER DEFAULT 0,
  PRIMARY KEY (kind, year)
);

