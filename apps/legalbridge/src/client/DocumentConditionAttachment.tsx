import { useEffect, useMemo, useState } from "react";

type AttachedCondition = {
  id:number; lineNo:number; conditionName:string; workId:number|null; workTitle:string|null;
  sourceWorkId:number|null; sourceWorkTitle:string|null; sourceMaterialId:number|null;
  sourceMaterialName:string|null; flowDirection:string|null; direction:string|null;
  transactionKind:string|null; paymentScheme:string|null; ratePct:number|null; currency:string|null;
  parentLicenseConditionId:number|null;
};
type Context = {
  document:{ id:number; documentNumber:string|null; templateType:string; title:string;
    contractId:number|null; workId:number|null; materialId:number|null; };
  conditions:AttachedCondition[];
};
type WorkSummary={id:number;workCode:string;title:string;conditionCount:number;materialCount:number};
type WorkDetail={
  work:WorkSummary;
  materials:Array<{id:number;materialCode:string|null;name:string}>;
  conditions:Array<{id:number;name:string;flowDirection:string|null;direction:string|null;
    counterparty:string|null;documentNumber:string|null;}>;
};
type VendorItem={id:string;label:string;description?:string;values?:Record<string,unknown>};

export function DocumentConditionAttachment({
  documentId,
  canAttach
}:{documentId:number;canAttach:boolean}) {
  const [context,setContext]=useState<Context|null>(null);
  const [open,setOpen]=useState(false);
  const [notice,setNotice]=useState("");
  const [saving,setSaving]=useState(false);

  const [workQuery,setWorkQuery]=useState("");
  const [works,setWorks]=useState<WorkSummary[]>([]);
  const [workId,setWorkId]=useState<number|undefined>(undefined);
  const [workDetail,setWorkDetail]=useState<WorkDetail|null>(null);
  const [sourceWorkId,setSourceWorkId]=useState<number|undefined>(undefined);
  const [materialId,setMaterialId]=useState<number|undefined>(undefined);

  const [vendorQuery,setVendorQuery]=useState("");
  const [vendors,setVendors]=useState<VendorItem[]>([]);
  const [vendorId,setVendorId]=useState<number|undefined>(undefined);

  const [flow,setFlow]=useState<"in"|"out">("in");
  const [parentInId,setParentInId]=useState<number|undefined>(undefined);
  const [name,setName]=useState("");
  const [scheme,setScheme]=useState("royalty");
  const [currency,setCurrency]=useState("JPY");
  const [rate,setRate]=useState("");
  const [amount,setAmount]=useState("");
  const [mg,setMg]=useState("");
  const [ag,setAg]=useState("");
  const [territory,setTerritory]=useState("");
  const [languages,setLanguages]=useState("");
  const [termStart,setTermStart]=useState("");
  const [termEnd,setTermEnd]=useState("");
  const [exclusivity,setExclusivity]=useState("");
  const [sublicense,setSublicense]=useState<""|"yes"|"no">("");
  const [royaltyBase,setRoyaltyBase]=useState("");
  const [deductions,setDeductions]=useState("");
  const [notes,setNotes]=useState("");

  async function loadContext(){
    const response=await fetch("/api/v2/documents/"+documentId+"/condition-attachments");
    if(!response.ok) return;
    const data=await response.json() as Context;
    setContext(data);
    if(data.document.workId) setWorkId(data.document.workId);
  }
  useEffect(()=>{ void loadContext(); },[documentId]);

  useEffect(()=>{
    if(!open) return;
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      fetch("/api/v2/work-rights?q="+encodeURIComponent(workQuery)+"&limit=50",{signal:controller.signal})
        .then(r=>r.ok?r.json():Promise.reject())
        .then(data=>setWorks(data.works??[]))
        .catch(e=>{ if(e?.name!=="AbortError") setWorks([]); });
    },200);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[open,workQuery]);

  useEffect(()=>{
    if(!workId){setWorkDetail(null);return;}
    const controller=new AbortController();
    fetch("/api/v2/work-rights/"+workId,{signal:controller.signal})
      .then(r=>r.ok?r.json():Promise.reject())
      .then((data:WorkDetail)=>setWorkDetail(data))
      .catch(e=>{if(e?.name!=="AbortError") setWorkDetail(null);});
    return()=>controller.abort();
  },[workId]);

  useEffect(()=>{
    if(!open||!vendorQuery.trim()){setVendors([]);return;}
    const controller=new AbortController();
    const timer=window.setTimeout(()=>{
      fetch("/api/v2/master-data/search?type=vendor&q="+encodeURIComponent(vendorQuery)+"&limit=20",{signal:controller.signal})
        .then(r=>r.ok?r.json():Promise.reject())
        .then(data=>setVendors(data.items??[]))
        .catch(e=>{if(e?.name!=="AbortError") setVendors([]);});
    },200);
    return()=>{controller.abort();window.clearTimeout(timer);};
  },[open,vendorQuery]);

  const inboundCandidates=useMemo(
    ()=>workDetail?.conditions.filter(c=>c.flowDirection==="in"||c.direction==="payable")??[],
    [workDetail]
  );

  async function attach(){
    if(!workId){setNotice("対象作品を選択してください。");return;}
    if(flow==="out" && !parentInId){
      const proceed=window.confirm("根拠IN条件が未設定です。このままOUT条件を登録しますか？");
      if(!proceed)return;
    }
    setSaving(true);setNotice("");
    try{
      const body={
        mode:"create",
        workId,
        sourceWorkId,
        sourceMaterialId:materialId,
        parentLicenseConditionId:flow==="out"?parentInId:undefined,
        counterpartyVendorId:vendorId,
        conditionName:name.trim()||(flow==="in"?"IN 利用許諾条件":"OUT 利用許諾条件"),
        flowDirection:flow,
        transactionKind:"license",
        paymentScheme:scheme,
        currency,
        ratePct:num(rate),
        amountExTax:num(amount),
        mgAmount:num(mg),
        agAmount:num(ag),
        territory:territory.trim()||undefined,
        languages:languages.split(/[,、/]/).map(v=>v.trim()).filter(Boolean),
        termStart:termStart||undefined,
        termEnd:termEnd||undefined,
        exclusivity:exclusivity||undefined,
        sublicenseAllowed:sublicense===""?undefined:sublicense==="yes",
        royaltyBase:royaltyBase.trim()||undefined,
        deductibleCosts:deductions.trim()||undefined,
        notes:notes.trim()||undefined
      };
      const response=await fetch("/api/v2/documents/"+documentId+"/condition-attachments",{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(result.error??"条件明細の登録に失敗しました。");
      setNotice(result.warnings?.length?result.warnings.join(" / "):"条件明細を文書・作品へ紐付けました。");
      setOpen(false);
      await loadContext();
    }catch(error){
      setNotice(error instanceof Error?error.message:"条件明細の登録に失敗しました。");
    }finally{setSaving(false);}
  }

  return <section className="document-condition-attachment">
    <div className="condition-attachment-head">
      <div><span>CONDITION LINKS</span><strong>条件明細・作品リンク</strong></div>
      {canAttach && <button onClick={()=>setOpen(v=>!v)}>{open?"閉じる":"＋ 後付け"}</button>}
    </div>
    {context?.conditions.length
      ? <div className="attached-condition-list">{context.conditions.map(c=>
          <article key={c.id}>
            <span>{c.flowDirection==="in"?"IN":c.flowDirection==="out"?"OUT":"条件"} #{c.id}</span>
            <strong>{c.conditionName}</strong>
            <small>{c.workTitle||"作品未設定"}{c.sourceMaterialName?" / "+c.sourceMaterialName:""}{c.ratePct!==null?" / "+c.ratePct+"%":""}</small>
            {c.parentLicenseConditionId && <small>根拠IN #{c.parentLicenseConditionId}</small>}
          </article>)}</div>
      : <p className="hub-note">この文書には条件明細が紐付いていません。過去文書でも後から作品・条件を登録できます。</p>}
    {notice && <div className="context-banner">{notice}</div>}

    {open && canAttach && <div className="condition-attachment-form">
      <div className="context-banner">
        利用許諾では対象作品を必須とし、OUTの場合は可能な限り根拠IN条件を指定してください。
        素材を選択したIN条件は権利ソースにも同時登録されます。
      </div>
      <div className="form-grid two">
        <label>IN / OUT
          <select value={flow} onChange={e=>{setFlow(e.target.value as "in"|"out");setParentInId(undefined);}}>
            <option value="in">IN（当社が権利を取得）</option>
            <option value="out">OUT（当社から利用許諾）</option>
          </select>
        </label>
        <label>条件名<input value={name} onChange={e=>setName(e.target.value)} placeholder="例：製造時利用許諾料" /></label>
      </div>

      <label>対象作品を検索<input value={workQuery} onChange={e=>setWorkQuery(e.target.value)} placeholder="作品名・作品コード" /></label>
      <div className="attachment-pick-list">{works.slice(0,10).map(w=>
        <button key={w.id} className={workId===w.id?"selected":""} onClick={()=>{setWorkId(w.id);setMaterialId(undefined);setParentInId(undefined);}}>
          <strong>{w.title}</strong><small>{w.workCode} / 条件{w.conditionCount}件</small>
        </button>)}</div>

      {workDetail && <>
        <div className="form-grid two">
          <label>原作・権利元作品（任意）
            <select value={sourceWorkId??""} onChange={e=>setSourceWorkId(e.target.value?Number(e.target.value):undefined)}>
              <option value="">指定なし</option>
              <option value={workDetail.work.id}>{workDetail.work.title}（同一作品）</option>
              {works.filter(w=>w.id!==workDetail.work.id).slice(0,30).map(w=><option key={w.id} value={w.id}>{w.title}</option>)}
            </select>
          </label>
          <label>対象素材（任意）
            <select value={materialId??""} onChange={e=>setMaterialId(e.target.value?Number(e.target.value):undefined)}>
              <option value="">作品全体</option>
              {workDetail.materials.map(m=><option key={m.id} value={m.id}>{m.materialCode||("#"+m.id)} {m.name}</option>)}
            </select>
          </label>
        </div>
        {flow==="out" && <label>根拠IN条件
          <select value={parentInId??""} onChange={e=>setParentInId(e.target.value?Number(e.target.value):undefined)}>
            <option value="">未設定（後から設定可能）</option>
            {inboundCandidates.map(c=><option key={c.id} value={c.id}>IN #{c.id} {c.name} {c.counterparty?"/ "+c.counterparty:""}</option>)}
          </select>
        </label>}
      </>}

      <label>相手方を検索<input value={vendorQuery} onChange={e=>setVendorQuery(e.target.value)} placeholder="取引先名" /></label>
      {vendors.length>0 && <div className="attachment-pick-list compact">{vendors.slice(0,8).map(v=>
        <button key={v.id} className={vendorId===Number(v.id)?"selected":""}
          onClick={()=>{setVendorId(Number(v.id));setVendorQuery(v.label);setVendors([]);}}>
          <strong>{v.label}</strong><small>{v.description||""}</small>
        </button>)}</div>}

      <div className="form-grid three">
        <label>支払方式
          <select value={scheme} onChange={e=>setScheme(e.target.value)}>
            <option value="royalty">利用実績連動</option><option value="fixed">固定額</option>
            <option value="subscription">定期払い</option><option value="other">その他</option>
          </select>
        </label>
        <label>通貨<input value={currency} onChange={e=>setCurrency(e.target.value.toUpperCase())} /></label>
        <label>料率（%）<input type="number" value={rate} onChange={e=>setRate(e.target.value)} /></label>
        <label>固定額・基準額<input type="number" value={amount} onChange={e=>setAmount(e.target.value)} /></label>
        <label>MG<input type="number" value={mg} onChange={e=>setMg(e.target.value)} /></label>
        <label>AG<input type="number" value={ag} onChange={e=>setAg(e.target.value)} /></label>
      </div>
      <div className="form-grid two">
        <label>地域<input value={territory} onChange={e=>setTerritory(e.target.value)} placeholder="全世界 / 日本 等" /></label>
        <label>言語<input value={languages} onChange={e=>setLanguages(e.target.value)} placeholder="日本語, 英語" /></label>
        <label>開始日<input type="date" value={termStart} onChange={e=>setTermStart(e.target.value)} /></label>
        <label>終了日<input type="date" value={termEnd} onChange={e=>setTermEnd(e.target.value)} /></label>
        <label>独占性<input value={exclusivity} onChange={e=>setExclusivity(e.target.value)} placeholder="非独占 / 独占" /></label>
        <label>再許諾
          <select value={sublicense} onChange={e=>setSublicense(e.target.value as ""|"yes"|"no")}>
            <option value="">未確認</option><option value="yes">可</option><option value="no">不可</option>
          </select>
        </label>
      </div>
      <label>ロイヤリティ算定基礎<textarea value={royaltyBase} onChange={e=>setRoyaltyBase(e.target.value)} placeholder="上代×製造数、当社実受領額等" /></label>
      <label>控除項目<textarea value={deductions} onChange={e=>setDeductions(e.target.value)} placeholder="海外源泉税、送金手数料等" /></label>
      <label>備考<textarea value={notes} onChange={e=>setNotes(e.target.value)} /></label>
      <div className="matter-form-actions">
        <button className="primary" disabled={saving||!workId} onClick={()=>void attach()}>
          {saving?"登録中…":"文書・作品へ条件をアタッチ"}
        </button>
      </div>
    </div>}
  </section>;
}

function num(value:string){
  if(!value.trim()) return undefined;
  const n=Number(value);
  return Number.isFinite(n)?n:undefined;
}
