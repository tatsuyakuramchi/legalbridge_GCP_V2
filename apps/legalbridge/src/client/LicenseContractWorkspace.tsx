import { useEffect, useMemo, useState } from "react";
import { RightsScopePicker } from "./RightsScopePicker";
import { displayScope, scopeContains, type ScopeOption } from "../rights-scope";

type WorkSummary = { id:number; workCode:string; title:string; materialCount:number; conditionCount:number; contractCount:number };
type Condition = {
  id:number; name:string; direction:string|null; flowDirection:string|null; paymentScheme:string|null;
  ratePct:number|null; mgAmount:number|null; currency:string|null; territory:string|null; language:string|null;
  regions:ScopeOption[]; languages:ScopeOption[];
  exclusivity:string|null; sublicenseAllowed:boolean|null; termStart:string|null; termEnd:string|null;
  parentLicenseConditionId:number|null; counterparty:string|null; documentNumber:string|null;
};
type WorkDetail = { work: WorkSummary & Record<string,unknown>; conditions: Condition[] };

export function LicenseContractWorkspace({
  initialIssueKey = "",
  initialWorkId,
  canSaveDraft,
  onOpenDraft
}: {
  initialIssueKey?: string;
  initialWorkId?: number;
  canSaveDraft: boolean;
  onOpenDraft: (issueKey:string, templateType:string) => void;
}) {
  const [issueKey,setIssueKey]=useState(initialIssueKey);
  const [works,setWorks]=useState<WorkSummary[]>([]);
  const [workId,setWorkId]=useState<number|null>(initialWorkId ?? null);
  const [detail,setDetail]=useState<WorkDetail|null>(null);
  const [direction,setDirection]=useState<"in"|"out">("out");
  const [sourceConditionId,setSourceConditionId]=useState<number|null>(null);
  const [counterparty,setCounterparty]=useState("");
  const [regions,setRegions]=useState<ScopeOption[]>([]);
  const [languages,setLanguages]=useState<ScopeOption[]>([]);
  const [exclusivity,setExclusivity]=useState("non_exclusive");
  const [sublicenseAllowed,setSublicenseAllowed]=useState(false);
  const [termStart,setTermStart]=useState("");
  const [termEnd,setTermEnd]=useState("");
  const [ratePct,setRatePct]=useState("");
  const [mgAmount,setMgAmount]=useState("");
  const [sellOffMonths,setSellOffMonths]=useState("");
  const [currency,setCurrency]=useState("JPY");
  const [templateType,setTemplateType]=useState("individual_license_terms");
  const [notice,setNotice]=useState("");
  const [working,setWorking]=useState(false);
  const territory=useMemo(()=>displayScope(regions),[regions]);
  const language=useMemo(()=>displayScope(languages),[languages]);

  useEffect(()=>{
    fetch("/api/v2/work-rights?limit=300")
      .then(r=>r.ok?r.json():Promise.reject())
      .then(data=>{
        const rows=data.works??[];
        setWorks(rows);
        setWorkId(current=>current??rows[0]?.id??null);
      }).catch(()=>setNotice("作品一覧を取得できませんでした。"));
  },[]);
  useEffect(()=>{
    if(!workId){setDetail(null);return;}
    fetch(`/api/v2/work-rights/${workId}`)
      .then(r=>r.ok?r.json():Promise.reject())
      .then(data=>{
        setDetail(data);
        const inbound=(data.conditions??[]).find((c:Condition)=>c.flowDirection==="in"||c.direction==="payable");
        setSourceConditionId(current=>current??inbound?.id??null);
      }).catch(()=>setNotice("作品の権利条件を取得できませんでした。"));
  },[workId]);

  const inbound=useMemo(()=>detail?.conditions.filter(c=>c.flowDirection==="in"||c.direction==="payable")??[],[detail]);
  const source=useMemo(()=>inbound.find(c=>c.id===sourceConditionId)??null,[inbound,sourceConditionId]);
  const checks=useMemo(()=>{
    if(direction!=="out"||!source) return [];
    const rows:Array<{label:string;ok:boolean;message:string}>=[];
    if(source.sublicenseAllowed===false) rows.push({label:"再許諾",ok:false,message:"根拠IN条件が再許諾不可です"});
    if(source.termEnd&&termEnd&&termEnd>source.termEnd) {
      rows.push({label:"期間",ok:false,message:`OUT終了日がIN終了日 ${source.termEnd} を超えています`});
    }

    if(regions.length) {
      const normalizedSourceRegions=(source.regions??[]).filter((item)=>!item.code.startsWith("LEGACY-"));
      if(normalizedSourceRegions.length) {
        if(!scopeContains(normalizedSourceRegions,regions,"WORLD")) {
          rows.push({label:"地域",ok:false,message:"OUT地域がIN地域の許諾範囲を超えています"});
        }
      } else if(source.territory&&!legacyScopeIncludes(source.territory,territory,"region")) {
        rows.push({label:"地域",ok:false,message:"根拠IN条件が旧形式です。OUT地域がIN地域の範囲内か確認してください"});
      }
    }

    if(languages.length) {
      const normalizedSourceLanguages=(source.languages??[]).filter((item)=>!item.code.startsWith("LEGACY-"));
      if(normalizedSourceLanguages.length) {
        if(!scopeContains(normalizedSourceLanguages,languages,"ALL")) {
          rows.push({label:"言語",ok:false,message:"OUT言語がIN言語の許諾範囲を超えています"});
        }
      } else if(source.language&&!legacyScopeIncludes(source.language,language,"language")) {
        rows.push({label:"言語",ok:false,message:"根拠IN条件が旧形式です。OUT言語がIN言語の範囲内か確認してください"});
      }
    }

    if(!rows.length) rows.push({label:"権利範囲",ok:true,message:"地域・言語・期間・再許諾の範囲内です"});
    return rows;
  },[direction,source,termEnd,regions,languages,territory,language]);

  async function createDraft(){
    if(!issueKey.trim()||!detail||!counterparty.trim()){setNotice("Request番号・作品・相手方を入力してください。");return;}
    if(!regions.length||!languages.length){setNotice("対象地域・対象言語を選択してください。");return;}
    if(direction==="out"&&!source){setNotice("OUT契約では根拠IN条件を選択してください。");return;}
    if(checks.some(c=>!c.ok)){setNotice("権利範囲チェックにNGがあります。修正してから進めてください。");return;}
    if(!canSaveDraft){setNotice("現在の環境では下書き保存が無効です。");return;}
    setWorking(true);setNotice("契約ドラフトを作成しています…");
    try{
      const formData=buildFormData();
      const response=await fetch(`/api/v2/document-drafts/${encodeURIComponent(issueKey.trim())}`,{
        method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({templateType,formData})
      });
      const result=await response.json();
      if(!response.ok){setNotice(result.error??"契約ドラフトを保存できませんでした。");return;}
      setNotice("契約ドラフトを作成しました。");
      onOpenDraft(issueKey.trim(),templateType);
    }catch{setNotice("契約ドラフト作成APIへ接続できませんでした。");}
    finally{setWorking(false);}
  }

  function buildFormData(){
    const workTitle=detail?.work.title??"";
    const sourceMeta={
      request_issue_key:issueKey.trim(),work_id:detail?.work.id,work_code:detail?.work.workCode,
      license_direction:direction,source_in_condition_id:source?.id??null,
      proposed_condition:{
        territory,language,regions,languages,exclusivity,sublicenseAllowed,termStart,termEnd,
        ratePct:Number(ratePct)||null,mgAmount:Number(mgAmount)||null,
        sellOffMonths:Number(sellOffMonths)||null,currency
      }
    };
    if(templateType==="license_out_en"){
      return {
        LICENSEE_NAME:counterparty,GAME_TITLE:workTitle,TERRITORIES:territory,
        LANGUAGE_VERSIONS:language,LICENSE_FEE:ratePct?`${ratePct}%`:"",
        ADVANCE_PAYMENT:mgAmount?currency+" "+mgAmount:"",
        AGREEMENT_END_DATE:termEnd,source_license_workflow:sourceMeta
      };
    }
    if(templateType==="license_master"){
      return {
        CONTRACT_DATE:termStart,VENDOR_NAME:direction==="in"?counterparty:"株式会社アークライト",
        PARTY_A_NAME:direction==="in"?"株式会社アークライト":counterparty,
        CONTRACT_PERIOD_SUMMARY:`${termStart||"—"} ～ ${termEnd||"—"}`,
        REMARKS:`対象作品: ${workTitle}\n地域: ${territory}\n言語: ${language}`,
        source_license_workflow:sourceMeta
      };
    }
    return {
      基本契約名: direction==="out"?"利用許諾契約":"利用許諾基本契約",
      Licensor_氏名会社名:direction==="out"?"株式会社アークライト":counterparty,
      Licensee_氏名会社名:direction==="out"?counterparty:"株式会社アークライト",
      許諾開始日:termStart,原著作物名:workTitle,独占性:exclusivity,
      金銭条件1_地域言語ラベル:[territory,language].filter(Boolean).join(" / "),
      金銭条件1_計算方式:"ROYALTY",金銭条件1_料率:Number(ratePct)||0,
      金銭条件1_通貨:currency,金銭条件1_支払条件:"",
      financial_conditions:[{
        condition_name:"利用許諾条件",region_language_label:[territory,language].filter(Boolean).join(" / "),
        calc_method:"ROYALTY",rate_pct:Number(ratePct)||0,mg_amount:Number(mgAmount)||0,
        currency,payment_terms:"",rights_holder:direction==="out"?"発注者":"受注者"
      }],
      特記事項_本文:`Sell-off: ${sellOffMonths||"—"}か月`,
      source_license_workflow:sourceMeta
    };
  }

  return <section className="page license-contract-workspace">
    <div className="page-title"><div><p>LICENSE CONTRACT WORKFLOW</p><h1>新規ライセンス契約</h1>
      <small>作品と権利ソースを先に確定し、IN/OUT条件を確認してから契約書ドラフトを生成します。</small></div></div>
    {notice&&<div className="context-banner">{notice}</div>}
    <div className="license-workflow-steps"><span className="active">1. Request</span><i>→</i><span>2. 作品</span><i>→</i><span>3. 権利ソース</span><i>→</i><span>4. 条件</span><i>→</i><span>5. Document</span></div>
    <div className="license-contract-layout">
      <div className="panel license-contract-form">
        <section><h2>Request・方向</h2><div className="field-grid">
          <label><span>Request / Backlog課題キー</span><input value={issueKey} onChange={e=>setIssueKey(e.target.value)} placeholder="LEGAL-1234"/></label>
          <label><span>方向</span><select value={direction} onChange={e=>setDirection(e.target.value as "in"|"out")}><option value="in">当社が権利を取得する（IN）</option><option value="out">当社が第三者へ許諾する（OUT）</option></select></label>
        </div></section>
        <section><h2>作品</h2><select value={workId??""} onChange={e=>setWorkId(Number(e.target.value)||null)}><option value="">作品を選択</option>{works.map(w=><option key={w.id} value={w.id}>{w.workCode} {w.title}</option>)}</select></section>
        {direction==="out"&&<section><h2>根拠IN条件</h2><select value={sourceConditionId??""} onChange={e=>setSourceConditionId(Number(e.target.value)||null)}><option value="">IN条件を選択</option>{inbound.map(c=><option key={c.id} value={c.id}>#{c.id} {c.name} / {c.counterparty||""}</option>)}</select>
          {source&&<div className="source-condition-card"><b>#{source.id} {source.name}</b><span>{scopeLabel(source.regions,source.territory)} / {scopeLabel(source.languages,source.language)} / 再許諾 {source.sublicenseAllowed?"可":"要確認"} / ～{source.termEnd||"—"}</span></div>}
        </section>}
        <section><h2>今回の取引条件</h2><div className="field-grid">
          <label><span>相手方</span><input value={counterparty} onChange={e=>setCounterparty(e.target.value)}/></label>
          <div className="wide">
            <RightsScopePicker
              regions={regions}
              languages={languages}
              onRegionsChange={setRegions}
              onLanguagesChange={setLanguages}
            />
          </div>
          <label><span>独占性</span><select value={exclusivity} onChange={e=>setExclusivity(e.target.value)}><option value="non_exclusive">非独占</option><option value="exclusive">独占</option><option value="sole">Sole</option></select></label>
          <label><span>開始日</span><input type="date" value={termStart} onChange={e=>setTermStart(e.target.value)}/></label>
          <label><span>終了日</span><input type="date" value={termEnd} onChange={e=>setTermEnd(e.target.value)}/></label>
          <label><span>料率（%）</span><input type="number" step="0.01" value={ratePct} onChange={e=>setRatePct(e.target.value)}/></label>
          <label><span>MG</span><input type="number" value={mgAmount} onChange={e=>setMgAmount(e.target.value)}/></label>
          <label><span>通貨</span><select value={currency} onChange={e=>setCurrency(e.target.value)}><option>JPY</option><option>EUR</option><option>USD</option></select></label>
          <label><span>Sell-off（月）</span><input type="number" value={sellOffMonths} onChange={e=>setSellOffMonths(e.target.value)}/></label>
          <label className="check"><input type="checkbox" checked={sublicenseAllowed} onChange={e=>setSublicenseAllowed(e.target.checked)}/>今回契約で再許諾を認める</label>
        </div></section>
      </div>
      <aside className="panel license-contract-preview">
        <span className="detail-kicker">RIGHTS CHECK</span><h2>IN / OUT確認</h2>
        {direction==="in"?<div className="context-banner">IN契約として新しい権利ソースを取得します。締結後に作品・素材の権利ソースへ登録します。</div>:<>
          {!source&&<div className="empty-detail">根拠IN条件を選択してください。</div>}
          {source&&<table className="rights-matrix"><thead><tr><th>条件</th><th>IN</th><th>今回OUT</th></tr></thead><tbody>
            <tr><th>地域</th><td>{scopeLabel(source.regions,source.territory)}</td><td>{territory||"—"}</td></tr>
            <tr><th>言語</th><td>{scopeLabel(source.languages,source.language)}</td><td>{language||"—"}</td></tr>
            <tr><th>再許諾</th><td>{source.sublicenseAllowed?"可":"不可/要確認"}</td><td>{sublicenseAllowed?"可":"不可"}</td></tr>
            <tr><th>期間</th><td>{source.termStart||"—"} ～ {source.termEnd||"—"}</td><td>{termStart||"—"} ～ {termEnd||"—"}</td></tr>
          </tbody></table>}
          {checks.map((c,i)=><div key={i} className={c.ok?"rights-check-ok":"rights-check-ng"}>{c.ok?"✓":"!"} {c.message}</div>)}
        </>}
        <h3>生成する文書</h3><select value={templateType} onChange={e=>setTemplateType(e.target.value)}>
          <option value="individual_license_terms">個別利用許諾条件書</option>
          <option value="license_out_en">LICENSE AGREEMENT（英文）</option>
          <option value="license_master">ライセンス利用許諾基本契約書</option>
        </select>
        <button className="primary license-draft-button" disabled={working||!canSaveDraft} onClick={createDraft}>{working?"作成中…":"契約書ドラフトを作成"}</button>
        {!canSaveDraft&&<small>現在の環境ではDraft書込みが無効です。</small>}
      </aside>
    </div>
  </section>;
}
function legacyScopeIncludes(
  source:string,
  target:string,
  kind:"region"|"language"
){
  const s=source.trim().toLowerCase();
  const t=target.trim().toLowerCase();
  if(!s||!t) return false;
  if(kind==="region"&&(s.includes("全世界")||s.includes("world"))) return true;
  if(kind==="language"&&(s.includes("全言語")||s.includes("all language"))) return true;
  return s.includes(t)||t.includes(s);
}
function scopeLabel(values:ScopeOption[]|undefined,fallback:string|null){
  return values?.length ? displayScope(values) : fallback||"—";
}
