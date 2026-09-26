import express, { Router } from "express";
import type { Transactable } from "../core/db.js";
import { DomainError, statusFor } from "../core/errors.js";
import { UPLOAD_KINDS, UPLOAD_KIND_LABEL, UPLOAD_MAX_BYTES, type RequesterUploadService } from "./upload-service.js";

/**
 * 依頼者の資料アップロードのページ（A-055）。/internal/upload に置く。
 *
 * 依頼者は V3 に入れないので、ユーザー認証の外に置き、署名付きのリンク（?t=）で守る。
 * ページは素の HTML（画面のビルドを読ませない）。ファイルは 1 本ずつ本文そのままで送る
 * （マルチパートを解かずに済み、30MB の上限もここで効かせられる）。
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function uploadPageHtml(input: { token: string; label: string; title: string }): string {
  const kinds = UPLOAD_KINDS.map((k) =>
    `<option value="${k}"${k === "reference" ? " selected" : ""}>${esc(UPLOAD_KIND_LABEL[k])}</option>`).join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>資料アップロード｜法務</title>
<style>
:root{color-scheme:light dark;--bg:#f7f6f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a64;--line:#dcdad2;--accent:#2f5d50;--bad:#a33}
@media (prefers-color-scheme:dark){:root{--bg:#171715;--card:#20201d;--ink:#ecebe6;--muted:#a5a39b;--line:#3a3935;--accent:#7fb8a4;--bad:#e88}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:20px;margin-top:16px}
h1{font-size:20px;margin:0}.muted{color:var(--muted);font-size:13px}.code{font-family:ui-monospace,monospace}
label{display:block;margin-top:14px;font-weight:600;font-size:13px}
select,input[type=text],input[type=email],textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
.drop{margin-top:14px;border:2px dashed var(--line);border-radius:8px;padding:28px;text-align:center;cursor:pointer}
.drop.on{border-color:var(--accent)}
button{margin-top:16px;padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
ul{padding-left:18px}.ok{color:var(--accent)}.bad{color:var(--bad)}
</style></head>
<body><main>
<h1>資料アップロード</h1>
<p class="muted">法務への依頼に資料を添えるページです。ここで上げた資料は法務に届き、依頼に繋がります。</p>
<div class="card">
  <div class="muted">送り先</div>
  <div><span class="code">${esc(input.label)}</span>　${esc(input.title)}</div>
</div>
<div class="card">
  <label for="kind">資料の種別</label>
  <select id="kind">${kinds}</select>
  <label for="email">あなたのメールアドレス（任意）</label>
  <input id="email" type="email" autocomplete="email" placeholder="you@example.com">
  <label for="note">ひとこと（任意）</label>
  <input id="note" type="text" maxlength="500" placeholder="第2版です、など">
  <div id="drop" class="drop" tabindex="0">ここにファイルをドロップ、または押して選ぶ<br><span class="muted">1 ファイル 30MB まで。複数まとめて選べます</span></div>
  <input id="file" type="file" multiple hidden>
  <ul id="list"></ul>
  <button id="send" disabled>アップロードする</button>
</div>
<p class="muted">リンクの有効期限は 30 日です。うまくいかないときは、法務に直接送ってください。</p>
</main>
<script>
(function(){
  var token=${JSON.stringify(input.token)}, max=${UPLOAD_MAX_BYTES}, files=[];
  var drop=document.getElementById("drop"), input=document.getElementById("file"), list=document.getElementById("list"), send=document.getElementById("send");
  function show(){ list.innerHTML=""; files.forEach(function(f){ var li=document.createElement("li"); li.id="f"+f.i;
    li.textContent=f.file.name+"（"+Math.ceil(f.file.size/1024).toLocaleString()+" KB）"+(f.file.size>max?" — 30MB を超えています":""); if(f.file.size>max) li.className="bad"; list.appendChild(li); });
    send.disabled=!files.some(function(f){return f.file.size<=max && !f.done;}); }
  function add(fl){ for(var i=0;i<fl.length;i++) files.push({file:fl[i],i:files.length}); show(); }
  drop.onclick=function(){ input.click(); }; drop.onkeydown=function(e){ if(e.key==="Enter"||e.key===" ") input.click(); };
  input.onchange=function(){ add(input.files); input.value=""; };
  drop.ondragover=function(e){ e.preventDefault(); drop.classList.add("on"); };
  drop.ondragleave=function(){ drop.classList.remove("on"); };
  drop.ondrop=function(e){ e.preventDefault(); drop.classList.remove("on"); add(e.dataTransfer.files); };
  send.onclick=async function(){
    send.disabled=true;
    var kind=document.getElementById("kind").value, email=document.getElementById("email").value, note=document.getElementById("note").value;
    for (var k=0;k<files.length;k++){ var f=files[k]; if(f.done||f.file.size>max) continue;
      var li=document.getElementById("f"+f.i); li.textContent=f.file.name+" … 送っています";
      try{
        var q="?t="+encodeURIComponent(token)+"&kind="+encodeURIComponent(kind)+"&name="+encodeURIComponent(f.file.name)
          +"&email="+encodeURIComponent(email)+"&note="+encodeURIComponent(note);
        var r=await fetch(location.pathname.replace(/\/+$/,"")+"/file"+q,{method:"POST",headers:{"content-type":f.file.type||"application/octet-stream"},body:f.file});
        var j=await r.json().catch(function(){return {};});
        if(!r.ok) throw new Error(j.error||("送れませんでした（"+r.status+"）"));
        f.done=true; li.className="ok"; li.textContent="✓ "+f.file.name+"（受付番号 "+j.uploadNo+"）";
      }catch(e){ li.className="bad"; li.textContent="✗ "+f.file.name+"："+e.message; }
    }
    send.disabled=!files.some(function(f){return !f.done && f.file.size<=max;});
  };
})();
</script>
</body></html>`;
}

const errorHtml = (message: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>資料アップロード｜法務</title>
<style>body{font:15px/1.7 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px}</style></head>
<body><h1>資料アップロード</h1><p>${esc(message)}</p></body></html>`;

/** /internal/upload。app.ts で /internal の手前に、大きめの本文の上限で置く。 */
export function createUploadRouter(_database: Transactable, uploads: RequesterUploadService) {
  const router = Router();

  router.get("/", async (req, res) => {
    try {
      const token = String(req.query.t ?? "");
      const target = uploads.verify(token);
      const where = await uploads.describe(target.target, target.id);
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.type("html").send(uploadPageHtml({ token, label: where.label, title: where.title }));
    } catch (error) {
      const e = error as DomainError;
      res.status(e instanceof DomainError ? statusFor(e.code) : 500)
        .type("html").send(errorHtml(e instanceof DomainError ? e.message : "ページを開けませんでした"));
    }
  });

  router.post("/file", express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES + 1024 }), async (req, res) => {
    try {
      const target = uploads.verify(String(req.query.t ?? ""));
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const record = await uploads.store(target, {
        name: String(req.query.name ?? "file"),
        mimeType: String(req.header("content-type") ?? "application/octet-stream").split(";")[0].trim(),
        data
      }, {
        kind: String(req.query.kind ?? ""),
        uploaderEmail: req.query.email ? String(req.query.email) : null,
        note: req.query.note ? String(req.query.note) : null
      });
      res.status(201).json({ uploadNo: record.uploadNo, fileName: record.fileName });
    } catch (error) {
      const e = error as DomainError;
      if (!(e instanceof DomainError)) console.error("upload failed", (error as Error)?.message);
      res.status(e instanceof DomainError ? statusFor(e.code) : 500)
        .json({ error: e instanceof DomainError ? e.message : "保存できませんでした。法務に直接送ってください" });
    }
  });

  // 上限を超えた本文（express.raw が 413 を投げる）を文字で返す。
  router.use((err: any, _req: any, res: any, next: any) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "1 ファイル 30MB までです" });
    next(err);
  });
  return router;
}
