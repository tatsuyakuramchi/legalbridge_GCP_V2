import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentFormSchema } from "../../types.js";
import { MemoryTemplateRepository } from "./template-repository.js";
import { runTemplateRegression } from "./template-regression.js";

const schema: DocumentFormSchema = {
  templateKey: "regression_sample",
  templateVersionId: 7,
  label: "回帰検査サンプル",
  fields: [
    { name: "TITLE", label: "件名", required: true },
    { name: "ISSUE_DATE", label: "発行日", type: "date", required: true }
  ]
};

test("全テンプレートを読取専用で検証しHTMLをレンダリングする", async () => {
  const repository = new MemoryTemplateRepository(
    [schema],
    { regression_sample: "<h1>{{TITLE}}</h1><p>{{ISSUE_DATE}}</p>" }
  );

  const report = await runTemplateRegression(repository);

  assert.deepEqual(report.summary, { total: 1, passed: 1, warnings: 0, failed: 0 });
  assert.equal(report.templates[0].status, "ok");
  assert.equal(report.templates[0].checks.validation, true);
  assert.equal(report.templates[0].checks.htmlRender, true);
  assert.ok(report.templates[0].renderedBytes > 0);
});

test("render source欠落を個別エラーとして報告し検査全体を停止しない", async () => {
  const missing = { ...schema, templateKey: "missing_source", templateVersionId: 8 };
  const repository = new MemoryTemplateRepository(
    [schema, missing],
    { regression_sample: "<p>{{TITLE}}</p>" }
  );

  const report = await runTemplateRegression(repository);

  assert.deepEqual(report.summary, { total: 2, passed: 1, warnings: 0, failed: 1 });
  const failure = report.templates.find((item) => item.templateKey === "missing_source");
  assert.equal(failure?.status, "error");
  assert.match(failure?.error ?? "", /render source is missing/);
});
