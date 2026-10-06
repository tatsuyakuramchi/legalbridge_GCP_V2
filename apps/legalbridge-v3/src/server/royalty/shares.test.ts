import test from "node:test";
import assert from "node:assert/strict";
import { allocateShares, pickShare, validateShareInput } from "./shares.js";
import { DomainError } from "../core/errors.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

test("取り分は四捨五入で割る", () => {
  // 光砕のリヴァルチャー：56,460 を 75/25
  assert.deepEqual(allocateShares(56460, [750000, 250000]), [42345, 14115]);
  // カローン・サンクションズ：5,610 を 30/40/30
  assert.deepEqual(allocateShares(5610, [300000, 400000, 300000]), [1683, 2244, 1683]);
});

test("四捨五入の合計が全体を超えたら、繰り上げ幅の大きい行（同点なら後ろ）から 1 円引く", () => {
  // 9,045 を 50/50 → 4,522.5 × 2 → 四捨五入で 9,046。超過 1 円は後ろの行から引く
  assert.deepEqual(allocateShares(9045, [500000, 500000]), [4523, 4522]);
  // 100 を 1/3 ずつ → 33.33… → 33 × 3 = 99。下回るぶんはそのまま（全体を超えない）
  assert.deepEqual(allocateShares(100, [333334, 333333, 333333]), [33, 33, 33]);
  // 101 を 1/3 ずつ（33.67, 33.67, 33.67 → 34 × 3 = 102）。超過 1 は後ろから
  assert.deepEqual(allocateShares(101, [333334, 333333, 333333]), [34, 34, 33]);
});

test("合計は全体を超えない（総当たり）", () => {
  const patterns = [[600000, 400000], [500000, 500000], [300000, 400000, 300000],
                    [750000, 250000], [333334, 333333, 333333], [100000, 900000]];
  for (let total = 0; total < 2000; total += 7) {
    for (const p of patterns) {
      const out = allocateShares(total, p);
      assert.ok(sum(out) <= total, `${total} ${p}: ${out}`);
      assert.ok(total - sum(out) <= p.length, "下回っても 1 行 1 円まで");
      for (const v of out) assert.ok(v >= 0);
    }
  }
});

test("1 者 100% はそのまま、空なら空", () => {
  assert.deepEqual(allocateShares(12345, [1000000]), [12345]);
  assert.deepEqual(allocateShares(12345, []), []);
});

test("取り分の検証：合計 100%・2 者以上・重複なし", () => {
  validateShareInput([]);
  validateShareInput([{ partyId: 1, sharePpm: 600000 }, { partyId: 2, sharePpm: 400000 }]);
  assert.throws(() => validateShareInput([{ partyId: 1, sharePpm: 1000000 }]),
    (e: unknown) => e instanceof DomainError && /2 者以上/.test(e.message));
  assert.throws(() => validateShareInput([{ partyId: 1, sharePpm: 600000 }, { partyId: 2, sharePpm: 300000 }]),
    (e: unknown) => e instanceof DomainError && /合計を 100%/.test(e.message));
  assert.throws(() => validateShareInput([{ partyId: 1, sharePpm: 500000 }, { partyId: 1, sharePpm: 500000 }]),
    (e: unknown) => e instanceof DomainError && /2 回/.test(e.message));
});

test("受取人の選び方：取り分があれば必須、無ければ渡せない", () => {
  const shares = [
    { partyId: 1, partyName: "A", partyKind: "individual", sharePpm: 600000, sortOrder: 0, note: null },
    { partyId: 2, partyName: "B", partyKind: "individual", sharePpm: 400000, sortOrder: 1, note: null }
  ];
  assert.equal(pickShare(shares, 2)!.sharePpm, 400000);
  assert.throws(() => pickShare(shares, null), (e: unknown) => e instanceof DomainError && /受取人を選んで/.test(e.message));
  assert.throws(() => pickShare(shares, 9), (e: unknown) => e instanceof DomainError && /取り分にありません/.test(e.message));
  assert.equal(pickShare([], null), null);
  assert.throws(() => pickShare([], 1), (e: unknown) => e instanceof DomainError && /取り分がありません/.test(e.message));
});
