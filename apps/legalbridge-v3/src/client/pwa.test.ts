import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * PWA の配線が崩れていないか（public/ は Vite がそのまま配るので、型検査が効かない）。
 */
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");

test("manifest：インストールに要る項目と、指しているアイコンが揃っている", () => {
  const m = JSON.parse(read("public/manifest.webmanifest"));
  assert.equal(m.start_url, "/");
  assert.equal(m.scope, "/");
  assert.equal(m.display, "standalone");
  assert.match(m.theme_color, /^#[0-9A-Fa-f]{6}$/);
  assert.match(m.background_color, /^#[0-9A-Fa-f]{6}$/);
  const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"), "192 と 512 の PNG");
  assert.ok(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable"), "maskable");
  for (const icon of m.icons as Array<{ src: string }>) {
    assert.ok(existsSync(new URL(`public${icon.src}`, root)), `${icon.src} がある`);
  }
});

test("index.html：manifest・theme-color・iOS のアイコンを指している", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<meta name="theme-color"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
  assert.ok(existsSync(new URL("public/icons/apple-touch-icon.png", root)));
});

test("service worker：文法が通り、台帳（/api）には触らず、index.html はネットワーク優先", () => {
  const sw = read("public/sw.js");
  assert.doesNotThrow(() => new Function(sw), "文法");
  assert.match(sw, /\/\^\\\/api\(\\\/\|\$\)\//, "/api を素通し");
  assert.match(sw, /request\.mode === "navigate"/);
  assert.match(sw, /SKIP_WAITING/, "画面の「再読み込み」で入れ替える");
  // 版を上げたら古いキャッシュを捨てる。名前に版が入っていること。
  assert.match(sw, /const SHELL = `lb-shell-\$\{VERSION\}`/);
  assert.doesNotMatch(sw, /self\.skipWaiting\(\)\s*;?\s*\n\s*\}\)\(\)\);\s*\n\}\);\s*\n\s*self\.addEventListener\("activate"/, "install で勝手に skipWaiting しない");
});
