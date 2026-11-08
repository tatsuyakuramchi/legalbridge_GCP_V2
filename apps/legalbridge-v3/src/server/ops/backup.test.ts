import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync, deflateRawSync } from "node:zlib";
import { FakeDatabase } from "../core/fake-db.js";
import { buildZip, crc32 } from "../core/zip.js";
import { backupStamp, csvField, orderViews, rowsCsv } from "./backup.js";

test("CSV の欄はいつも引用符で囲み、中の引用符は二重にする（カンマ・改行・JSON も崩れない）", () => {
  assert.equal(csvField('{"a":"b, c"}'), '"{""a"":""b, c""}"');
  assert.equal(csvField("parties"), '"parties"');
});

test("ファイル名の印は東京の日時", () => {
  assert.equal(backupStamp(new Date("2026-11-08T15:05:00Z")), "20261109-0005");
});

test("ビューは依存の順。ほかのビューを使うものはあと、表への依存は気にしない", () => {
  const out = orderViews([
    { oid: 1, sql: "A uses B", deps: [2, 99] },
    { oid: 2, sql: "B", deps: [99] },
    { oid: 3, sql: "C uses A", deps: [1] }
  ]);
  assert.deepEqual(out, ["B", "A uses B", "C uses A"]);
  assert.deepEqual(orderViews([{ oid: 1, sql: "X", deps: [2] }, { oid: 2, sql: "Y", deps: [1] }]).sort(), ["X", "Y"], "輪になっていても止まらない");
});

test("ZIP：deflated を渡すと圧縮で入れ、展開すると元に戻る（CRC と大きさは元のもの）", () => {
  const data = new TextEncoder().encode("tbl,data\r\n".repeat(500));
  const zip = buildZip([{ name: "rows.csv", data, deflated: deflateRawSync(data) }]);
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(v.getUint32(0, true), 0x04034b50);
  assert.equal(v.getUint16(8, true), 8, "method: deflate");
  const compressed = v.getUint32(18, true), size = v.getUint32(22, true), nameLen = v.getUint16(26, true);
  assert.equal(size, data.length);
  assert.ok(compressed < size / 10, "よく縮む");
  assert.equal(v.getUint32(14, true), crc32(data));
  const body = zip.subarray(30 + nameLen, 30 + nameLen + compressed);
  assert.deepEqual(new Uint8Array(inflateRawSync(body)), data);
});

test("行の CSV：PDF の作り置きは入れず、表ごとの行数を数える", async () => {
  const db = new FakeDatabase((t, p) => {
    if (t.includes("FROM pg_class c JOIN pg_namespace")) return [{ name: "document_pdfs" }, { name: "parties" }, { name: "works" }];
    if (t.includes("format('%I.%I'")) return [{ q: `v3.${(p as string[])[1]}` }];
    if (t.includes("FROM v3.parties")) return [{ j: '{"id": 1, "name": "A, \\"B\\""}' }, { j: '{"id": 2}' }];
    if (t.includes("FROM v3.works")) return [];
    return undefined;
  });
  const r = await rowsCsv(db, "v3");
  assert.deepEqual(r.tables, [{ name: "parties", rows: 2 }, { name: "works", rows: 0 }]);
  assert.equal(r.csv.split("\r\n")[0], "tbl,data");
  assert.equal(r.csv.split("\r\n")[1], '"parties","{""id"": 1, ""name"": ""A, \\""B\\""""}"');
  assert.ok(!db.find("FROM v3.document_pdfs"), "PDF の作り置きは読まない");
});
