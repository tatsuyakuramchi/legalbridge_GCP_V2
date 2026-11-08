import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { inTransaction, type Queryable, type Transactable } from "../core/db.js";
import { translate } from "../core/errors.js";
import { buildZip } from "../core/zip.js";

/**
 * ローカル予備系へのバックアップ（1 つの ZIP。監査・設定 › 出力 から落とす）。
 *
 * 予備系の自動同期は、社内ネットワーク（3307 番）と GCP の契約（バケット）の都合で止まっている
 * （infra/local/README.md）。アプリは 443 番で開けるので、アプリから 1 ファイルで落とし、
 * 手元で `ops import-backup` に渡せば、ローカルが本番と同じ形・同じ中身になる。
 *
 *   manifest.json … いつ・どのアプリ（git のコミット・リビジョン・画面のビルド時刻）から取ったか、
 *                   表ごとの行数、入っているファイルの大きさと SHA-256
 *   schema.sql    … v3 スキーマの定義。本番のカタログから組み立てる（リポジトリの 001/004 は本番に
 *                   当てた後追いの変更を全部は持っていないので、そちらから作り直すと列が足りない）
 *   rows.csv      … 全部の表の中身。見出し tbl,data・1 行 1 件・中身は JSON（094_export_rows.sql と同じ形）
 *   README.txt    … 取り込み方
 *
 * 1 つの読み取り専用のトランザクション（REPEATABLE READ）で読むので、表どうしの時点がそろう。
 * PDF の作り置き（document_pdfs）は入れない（手元では文書を開けば作り直される）。
 * 中身は口座番号・連絡先を含む本番の写し。admin だけが落とせる。
 */

export const BACKUP_FORMAT = "legalbridge-v3-backup";
export const BACKUP_FORMAT_VERSION = 1;
/** 中身を入れない表。 */
export const BACKUP_EXCLUDED = ["document_pdfs"];

export interface BackupManifest {
  format: string;
  formatVersion: number;
  createdAt: string;
  createdBy: string;
  app: { gitSha: string | null; revision: string | null; clientBuiltAt: string | null };
  database: { schema: string; serverVersion: string | null };
  tables: Array<{ name: string; rows: number }>;
  excluded: string[];
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

export interface Backup {
  zip: Uint8Array;
  filename: string;
  manifest: BackupManifest;
}

/** CSV の 1 欄（いつも引用符で囲む）。 */
export const csvField = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** 東京の日時でファイル名の印（YYYYMMDD-HHMM）。 */
export const backupStamp = (d: Date): string => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour === "24" ? "00" : parts.hour}${parts.minute}`;
};

/**
 * スキーマの定義（DDL）をカタログから組み立てる。文は SQL の format()（%I・%L）で作り、
 * 引用の誤りを避ける。search_path を pg_catalog だけにして読むので、名前はすべて schema. 付きで出る。
 *
 * 順番：拡張機能 → 型 → 連番 → 関数 → 表（列・既定値）→ 連番の持ち主 → 主キー・一意・CHECK
 *       → 外部キー → 索引 → ビュー（依存の順）→ 引き金 → 連番の現在値 → 説明。
 * 権限は手元の 003_grants.sql で当て直すので入れない。
 */
export async function schemaSql(client: Queryable, schema: string, createdAt: string): Promise<string> {
  const rows = async (text: string, params: unknown[] = [schema]) => (await client.query(text, params)).rows as any[];
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);
  // 拡張機能の持ち物は拡張機能を入れれば戻るので、個別には出さない。
  const notExt = (classid: string, col: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = '${classid}'::regclass AND e.objid = ${col} AND e.deptype = 'e')`;

  add(`-- LegalBridge V3 バックアップ：${schema} スキーマの定義（本番のカタログから組み立てた。${createdAt}）`,
      "-- ops import-backup がこのファイルで表を作り直してから中身（rows.csv）を入れる。権限は 003_grants.sql で当て直す。",
      "SET check_function_bodies = false;",
      "SET client_min_messages = warning;",
      "SET search_path = pg_catalog, public;",
      "");
  add((await rows("SELECT format('CREATE SCHEMA IF NOT EXISTS %I;', $1::text) AS s"))[0].s, "");

  // 拡張機能。手元に無いもの（Cloud SQL だけのもの）は知らせて続ける。
  for (const r of await rows(
    `SELECT format('DO $x$ BEGIN CREATE EXTENSION IF NOT EXISTS %I WITH SCHEMA %I; EXCEPTION WHEN OTHERS THEN RAISE NOTICE %L, SQLERRM; END $x$;',
                   e.extname, n.nspname, '拡張機能 ' || e.extname || ' を入れられません: %') AS s
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql' AND n.nspname IN ($1, 'public') ORDER BY e.extname`)) add(r.s);
  add("");

  // 型：列挙 → ドメイン → 複合型
  for (const r of await rows(
    `SELECT format('CREATE TYPE %I.%I AS ENUM (%s);', n.nspname, t.typname,
                   (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)) AS s
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'e' AND ${notExt("pg_type", "t.oid")} ORDER BY t.typname`)) add(r.s);
  for (const r of await rows(
    `SELECT format('CREATE DOMAIN %I.%I AS %s%s%s;', n.nspname, t.typname, format_type(t.typbasetype, t.typtypmod),
                   CASE WHEN t.typdefault IS NOT NULL THEN ' DEFAULT ' || t.typdefault ELSE '' END,
                   CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END)
           || COALESCE((SELECT string_agg(format(E'\\nALTER DOMAIN %I.%I ADD CONSTRAINT %I %s;', n.nspname, t.typname, c.conname,
                                                 pg_get_constraintdef(c.oid)), '' ORDER BY c.conname)
                          FROM pg_constraint c WHERE c.contypid = t.oid), '') AS s
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'd' AND ${notExt("pg_type", "t.oid")} ORDER BY t.typname`)) add(r.s);
  for (const r of await rows(
    `SELECT format('CREATE TYPE %I.%I AS (%s);', n.nspname, t.typname,
                   (SELECT string_agg(format('%I %s', a.attname, format_type(a.atttypid, a.atttypmod)), ', ' ORDER BY a.attnum)
                      FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)) AS s
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_class c ON c.oid = t.typrelid
      WHERE n.nspname = $1 AND t.typtype = 'c' AND c.relkind = 'c' AND ${notExt("pg_type", "t.oid")} ORDER BY t.typname`)) add(r.s);
  add("");

  // 連番（identity の連番は表と一緒にできるので除く）
  for (const r of await rows(
    `SELECT format('CREATE SEQUENCE %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;',
                   n.nspname, c.relname, format_type(s.seqtypid, NULL), s.seqincrement, s.seqmin, s.seqmax, s.seqstart, s.seqcache,
                   CASE WHEN s.seqcycle THEN ' CYCLE' ELSE '' END) AS s
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND ${notExt("pg_class", "c.oid")}
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i')
      ORDER BY c.relname`)) add(r.s);
  add("");

  // 関数（本文はそのまま。check_function_bodies を切っているので、表より先に作れる）
  for (const r of await rows(
    `SELECT pg_get_functiondef(p.oid) || ';' AS s
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${notExt("pg_proc", "p.oid")}
      ORDER BY p.proname, p.oid`)) add(r.s, "");

  // 表（列・既定値・NOT NULL・identity・生成列）。パーティションは親のあとに。
  for (const r of await rows(
    `SELECT CASE WHEN c.relispartition THEN
              format('CREATE TABLE %I.%I PARTITION OF %s %s;', n.nspname, c.relname,
                     (SELECT i.inhparent::regclass::text FROM pg_inherits i WHERE i.inhrelid = c.oid),
                     pg_get_expr(c.relpartbound, c.oid))
            ELSE
              format(E'CREATE TABLE %I.%I (\\n%s\\n)%s;', n.nspname, c.relname,
                (SELECT string_agg(
                   format('  %I %s', a.attname, format_type(a.atttypid, a.atttypmod))
                   || CASE WHEN a.attcollation <> 0 AND a.attcollation <> ty.typcollation
                           THEN (SELECT format(' COLLATE %I.%I', cn.nspname, co.collname)
                                   FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation)
                           ELSE '' END
                   || CASE WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY'
                           WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' ELSE '' END
                   || CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                           WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END
                   || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                   E',\\n' ORDER BY a.attnum)
                   FROM pg_attribute a
                   JOIN pg_type ty ON ty.oid = a.atttypid
                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
                CASE WHEN c.relkind = 'p' THEN ' PARTITION BY ' || pg_get_partkeydef(c.oid) ELSE '' END)
            END AS s
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND ${notExt("pg_class", "c.oid")}
      ORDER BY c.relispartition, c.relname`)) add(r.s, "");

  // 連番の持ち主（serial）
  for (const r of await rows(
    `SELECT format('ALTER SEQUENCE %I.%I OWNED BY %I.%I.%I;', sn.nspname, s.relname, tn.nspname, t.relname, a.attname) AS s
       FROM pg_depend d
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_namespace sn ON sn.oid = s.relnamespace
       JOIN pg_class t ON t.oid = d.refobjid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a' AND sn.nspname = $1
      ORDER BY s.relname`)) add(r.s);
  add("");

  // 制約：主キー・一意・CHECK・排他 → 外部キー（参照先の一意がそろってから）
  for (const r of await rows(
    `SELECT format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s;', n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid)) AS s
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND k.contype IN ('p', 'u', 'c', 'x', 'f') AND k.conislocal AND k.conparentid = 0
        AND ${notExt("pg_class", "c.oid")}
      ORDER BY k.contype = 'f', k.contype <> 'p', c.relname, k.conname`)) add(r.s);
  add("");

  // 索引（制約が持つ索引・パーティションの子の索引を除く）
  for (const r of await rows(
    `SELECT pg_get_indexdef(i.indexrelid) || ';' AS s
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = $1
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x'))
        AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid)
        AND ${notExt("pg_class", "i.indrelid")}
      ORDER BY ic.relname`)) add(r.s);
  add("");

  // ビュー（ほかのビューを使うビューはあとに）
  const views = await rows(
    `SELECT c.oid::bigint AS oid,
            CASE WHEN c.relkind = 'm'
                 THEN format(E'CREATE MATERIALIZED VIEW %I.%I AS\\n%s\\nWITH NO DATA;', n.nspname, c.relname, rtrim(pg_get_viewdef(c.oid), ';'))
                 ELSE format(E'CREATE VIEW %I.%I%s AS\\n%s;', n.nspname, c.relname,
                             CASE WHEN c.reloptions IS NOT NULL THEN ' WITH (' || array_to_string(c.reloptions, ', ') || ')' ELSE '' END,
                             rtrim(pg_get_viewdef(c.oid), ';'))
            END AS s,
            ARRAY(SELECT DISTINCT d.refobjid::bigint FROM pg_rewrite rw JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
                   WHERE rw.ev_class = c.oid AND d.refobjid <> c.oid) AS deps
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('v', 'm') AND ${notExt("pg_class", "c.oid")}
      ORDER BY c.relname`);
  for (const s of orderViews(views.map((v) => ({ oid: Number(v.oid), sql: String(v.s), deps: (v.deps as unknown[]).map(Number) })))) add(s, "");

  // 引き金
  for (const r of await rows(
    `SELECT pg_get_triggerdef(t.oid) || ';' AS s
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal AND t.tgparentid = 0 AND ${notExt("pg_class", "c.oid")}
      ORDER BY c.relname, t.tgname`)) add(r.s);
  add("");

  // 連番の現在値（serial の連番は中身を入れたあと最大値に合わせ直すが、表に付いていない連番はここで合わせる）
  for (const r of await rows(
    `SELECT format('SELECT setval(%L, %s, true);', format('%I.%I', s.schemaname, s.sequencename), s.last_value) AS s
       FROM pg_sequences s WHERE s.schemaname = $1 AND s.last_value IS NOT NULL ORDER BY s.sequencename`)) add(r.s);
  add("");

  // 説明（表・ビュー・列）
  for (const r of await rows(
    `SELECT format('COMMENT ON %s %I.%I IS %L;', CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                   n.nspname, c.relname, obj_description(c.oid, 'pg_class')) AS s
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') AND obj_description(c.oid, 'pg_class') IS NOT NULL
      ORDER BY c.relname`)) add(r.s);
  for (const r of await rows(
    `SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L;', n.nspname, c.relname, a.attname, col_description(c.oid, a.attnum)) AS s
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') AND col_description(c.oid, a.attnum) IS NOT NULL
      ORDER BY c.relname, a.attnum`)) add(r.s);

  return out.join("\n") + "\n";
}

/** ビューを依存の順に並べる（ほかのビューを使うものはあとに）。輪になっていれば残りを名前順で出す。 */
export function orderViews(views: Array<{ oid: number; sql: string; deps: number[] }>): string[] {
  const ids = new Set(views.map((v) => v.oid));
  const done = new Set<number>();
  const out: string[] = [];
  let left = [...views];
  while (left.length) {
    const ready = left.filter((v) => v.deps.every((d) => !ids.has(d) || done.has(d) || d === v.oid));
    const next = ready.length ? ready : left;
    for (const v of next) { out.push(v.sql); done.add(v.oid); }
    left = left.filter((v) => !done.has(v.oid));
  }
  return out;
}

/** 全部の表の中身（見出し tbl,data）。表ごとの行数も返す。 */
export async function rowsCsv(client: Queryable, schema: string): Promise<{ csv: string; tables: Array<{ name: string; rows: number }> }> {
  const tables = (await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`, [schema])).rows
    .map((r) => String(r.name)).filter((t) => !BACKUP_EXCLUDED.includes(t));
  const lines: string[] = ["tbl,data"];
  const counts: Array<{ name: string; rows: number }> = [];
  for (const name of tables) {
    const ident = (await client.query("SELECT format('%I.%I', $1::text, $2::text) AS q", [schema, name])).rows[0]!.q as string;
    const r = await client.query(`SELECT to_jsonb(r)::text AS j FROM ${ident} r`);
    for (const row of r.rows) lines.push(`${csvField(name)},${csvField(String(row.j))}`);
    counts.push({ name, rows: r.rows.length });
  }
  return { csv: lines.join("\r\n") + "\r\n", tables: counts };
}

const README = (m: BackupManifest) => `LegalBridge V3 バックアップ（${m.createdAt}）

本番の v3 を、ローカル予備系（infra/local）にそのまま入れるためのファイルです。
口座番号・連絡先などを含む本番の写しなので、置き場所と消し忘れに気をつけてください。

入っているもの
  manifest.json … 取った時点・本番のアプリの版（git ${m.app.gitSha ?? "不明"}）・表ごとの行数・ファイルの SHA-256
  schema.sql    … v3 スキーマの定義（本番のカタログから組み立てたもの）
  rows.csv      … 全部の表の中身（PDF の作り置き document_pdfs は除く。手元で開けば作り直されます）

取り込み方（infra/local で。PowerShell）
  1. アプリを本番と同じ版にそろえる
       git fetch
       git checkout ${m.app.gitSha && m.app.gitSha !== "unknown" ? m.app.gitSha : "main"}      （main のままでよければ git pull）
       docker compose up -d --build app
  2. この ZIP を infra/local/dumps/ に置いて
       docker compose run --rm ops import-backup /dumps/<この ZIP の名前>
     手元の v3 は入れ替わります（入れ替える前の写しは dumps/before_import_*.dump に自動で取ります）。
  3. 取り込んだら ZIP を消す
`;

/** バックアップの ZIP を組む。 */
export async function buildBackup(database: Transactable, opts: {
  schema: string; actor: string; now?: Date;
  app: { gitSha: string | null; revision: string | null; clientBuiltAt: string | null };
}): Promise<Backup> {
  const now = opts.now ?? new Date();
  const createdAt = now.toISOString();
  try {
    const { schemaText, data, serverVersion } = await inTransaction(database, async (client) => {
      // 表どうしの時点をそろえる（読み取り専用・同じ時点の写し）。
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      // 定義の名前をすべて schema. 付きで出すため、カタログだけを見る。
      await client.query("SET LOCAL search_path = pg_catalog");
      const serverVersion = String((await client.query("SHOW server_version")).rows[0]?.server_version ?? "") || null;
      const schemaText = await schemaSql(client, opts.schema, createdAt);
      const data = await rowsCsv(client, opts.schema);
      return { schemaText, data, serverVersion };
    });
    const enc = new TextEncoder();
    const schemaBytes = enc.encode(schemaText);
    const rowsBytes = enc.encode(data.csv);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, createdAt, createdBy: opts.actor,
      app: opts.app, database: { schema: opts.schema, serverVersion },
      tables: data.tables, excluded: BACKUP_EXCLUDED,
      files: [
        { name: "schema.sql", bytes: schemaBytes.length, sha256: sha256(schemaBytes) },
        { name: "rows.csv", bytes: rowsBytes.length, sha256: sha256(rowsBytes) }
      ]
    };
    const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2) + "\n");
    const readmeBytes = enc.encode(README(manifest).replace(/\n/g, "\r\n"));
    const zip = buildZip([
      { name: "manifest.json", data: manifestBytes, mtime: now },
      { name: "README.txt", data: readmeBytes, mtime: now },
      { name: "schema.sql", data: schemaBytes, deflated: deflateRawSync(schemaBytes), mtime: now },
      { name: "rows.csv", data: rowsBytes, deflated: deflateRawSync(rowsBytes, { level: 6 }), mtime: now }
    ]);
    return { zip, filename: `legalbridge-backup-${backupStamp(now)}.zip`, manifest };
  } catch (error) { throw translate(error); }
}
