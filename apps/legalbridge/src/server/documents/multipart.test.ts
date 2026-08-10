import assert from "node:assert/strict";
import test from "node:test";
import { MultipartError, parseBoundary, parseMultipart } from "./multipart.js";

function buildBody(boundary: string, parts: Array<{ headers: string[]; data: Buffer | string }>) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("multipart: boundary 抽出（素・引用符・パラメータ後続）", () => {
  assert.equal(parseBoundary("multipart/form-data; boundary=abc123"), "abc123");
  assert.equal(parseBoundary('multipart/form-data; boundary="xyz -9"'), "xyz -9");
  assert.throws(() => parseBoundary("application/json"), MultipartError);
  assert.throws(() => parseBoundary("multipart/form-data"), MultipartError);
});

test("multipart: フィールドとファイルを分離して取り出す", () => {
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff]);
  const body = buildBody("B", [
    { headers: ['Content-Disposition: form-data; name="docKind"'], data: "reference" },
    { headers: ['Content-Disposition: form-data; name="originalName"'], data: "契約書ドラフト.pdf" },
    {
      headers: [
        'Content-Disposition: form-data; name="file"; filename="a.pdf"',
        "Content-Type: application/pdf"
      ],
      data: pdf
    }
  ]);
  const parsed = parseMultipart(body, "multipart/form-data; boundary=B");
  assert.equal(parsed.fields.docKind, "reference");
  assert.equal(parsed.fields.originalName, "契約書ドラフト.pdf");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].field, "file");
  assert.equal(parsed.files[0].filename, "a.pdf");
  assert.equal(parsed.files[0].contentType, "application/pdf");
  assert.deepEqual(parsed.files[0].data, pdf);
});

test("multipart: バイナリ中に CRLF や境界風文字列があっても壊れない", () => {
  const tricky = Buffer.concat([
    Buffer.from("head\r\n\r\nmiddle--Bnot-a-boundary\r\n"),
    Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x2d, 0x2d]),
    Buffer.from("tail")
  ]);
  const body = buildBody("Boundary777", [
    {
      headers: ['Content-Disposition: form-data; name="file"; filename="bin.dat"'],
      data: tricky
    }
  ]);
  const parsed = parseMultipart(body, "multipart/form-data; boundary=Boundary777");
  assert.deepEqual(parsed.files[0].data, tricky);
});

test("multipart: filename 空文字はファイル扱い（未選択 input の挙動）", () => {
  const body = buildBody("B", [
    { headers: ['Content-Disposition: form-data; name="file"; filename=""'], data: "" }
  ]);
  const parsed = parseMultipart(body, "multipart/form-data; boundary=B");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, "");
  assert.equal(parsed.files[0].data.length, 0);
});

test("multipart: エスケープされた引用符入り filename", () => {
  const body = buildBody("B", [
    {
      headers: ['Content-Disposition: form-data; name="file"; filename="a\\"b.pdf"'],
      data: "x"
    }
  ]);
  const parsed = parseMultipart(body, "multipart/form-data; boundary=B");
  assert.equal(parsed.files[0].filename, 'a"b.pdf');
});

test("multipart: 不正本文は MALFORMED", () => {
  assert.throws(
    () => parseMultipart(Buffer.from("garbage"), "multipart/form-data; boundary=B"),
    (e: unknown) => e instanceof MultipartError && e.code === "MALFORMED");
  assert.throws(
    () => parseMultipart(Buffer.from("--B\r\nContent-Disposition: form-data; name=\"x\""),
      "multipart/form-data; boundary=B"),
    (e: unknown) => e instanceof MultipartError && e.code === "MALFORMED");
});

test("multipart: 複数ファイル", () => {
  const body = buildBody("B", [
    { headers: ['Content-Disposition: form-data; name="file"; filename="1.txt"', "Content-Type: text/plain"], data: "one" },
    { headers: ['Content-Disposition: form-data; name="file"; filename="2.txt"', "Content-Type: text/plain"], data: "two" }
  ]);
  const parsed = parseMultipart(body, "multipart/form-data; boundary=B");
  assert.deepEqual(parsed.files.map((f) => f.filename), ["1.txt", "2.txt"]);
  assert.deepEqual(parsed.files.map((f) => f.data.toString()), ["one", "two"]);
});
