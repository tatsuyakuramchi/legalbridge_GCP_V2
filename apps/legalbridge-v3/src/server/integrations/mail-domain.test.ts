import test from "node:test";
import assert from "node:assert/strict";
import { undeliverableEmails, type DomainResolver } from "./mail-domain.js";

const err = (code: string) => Object.assign(new Error(code), { code });
const resolver = (table: Record<string, { mx?: string[] | string; a?: string[] | string }>): DomainResolver => ({
  mx: async (d) => { const v = table[d]?.mx; if (typeof v === "string") throw err(v); if (!v) throw err("ENOTFOUND"); return v; },
  a: async (d) => { const v = table[d]?.a; if (typeof v === "string") throw err(v); if (!v) throw err("ENOTFOUND"); return v; }
});

test("MX も A も無いドメインの宛先は届かない、と返す", async () => {
  const r = resolver({ "zensou.co.jp": { mx: "ENODATA", a: "ENODATA" }, "zensou.jp": { mx: ["zensou.jp"] } });
  assert.deepEqual(await undeliverableEmails(["info@zensou.co.jp", "info@zensou.jp"], r), ["info@zensou.co.jp"]);
});

test("MX が無くても A があれば届く。DNS が引けない（タイムアウト等）ときは止めない", async () => {
  const r = resolver({ "a-only.jp": { mx: "ENODATA", a: ["1.2.3.4"] }, "flaky.jp": { mx: "ESERVFAIL" } });
  assert.deepEqual(await undeliverableEmails(["x@a-only.jp", "y@flaky.jp"], r), []);
});
