import Handlebars from "handlebars";
import type { DocumentFormSchema, TemplateField } from "../../types.js";
import { buildIndividualLicenseV3Context, INDIVIDUAL_LICENSE_V3_KEY } from "./individual-license-v3.js";
import { buildRenderContext, registerLegacyHelpers } from "./rendering.js";

const BUILTIN_HELPERS = new Set(["if", "unless", "each", "with", "lookup", "log"]);
const REGISTERED_HELPERS = new Set(["eq","ne","formatCurrency","formatDate","formatDateCompact","add","multiply","index1","circledNum","formatPct","formatYen","formatMoney","or","gt","lt","join","length","concat","cycleLabel","invoiceLabel","cycleLabelEn","billingDayLabel","billingDayLabelEn"]);
export interface TemplateCompatibilityResult { templateKey:string; label:string; fieldCount:number; status:"ok"|"warning"|"error"; variables:string[]; helpers:string[]; partials:string[]; missingHelpers:string[]; missingPartials:string[]; unmappedVariables:string[]; renderError?:string }
export function inspectTemplateCompatibility(schema:DocumentFormSchema, htmlSource:string, partialSources:Record<string,string>):TemplateCompatibilityResult {
 const expressions=[...htmlSource.matchAll(/{{{?\s*([^{}!][^{}]*?)\s*}?}}/g)].map(m=>m[1].trim()).filter(Boolean);
 const partials=unique(expressions.filter(i=>i.startsWith(">")).map(i=>i.slice(1).trim().split(/\s+/)[0]));
 const helpers=unique(expressions.flatMap(i=>{const t=i.replace(/^[#/^]/,"").trim().split(/\s+/);return t.length>1&&!i.startsWith(">")?[t[0]]:[]}));
 const variables=unique(expressions.flatMap(i=>{if(/^(else|[#/^>])/.test(i))return[];const t=i.split(/\s+/);return t.length>1?t.slice(1):t}).map(cleanToken).filter(t=>t&&!t.startsWith("@")&&!t.startsWith(".")&&!/^['"\d]/.test(t)));
 const missingHelpers=helpers.filter(h=>!BUILTIN_HELPERS.has(h)&&!REGISTERED_HELPERS.has(h));
 const missingPartials=partials.filter(p=>!(p in partialSources));
 const fieldNames=new Set(schema.fields.map(f=>f.name));
 const unmappedVariables=variables.filter(v=>{const root=v.split(/[.[\]]/,1)[0];return root&&!fieldNames.has(root)&&!knownGeneratedVariable(schema.templateKey,root)});
 let renderError:string|undefined;
 try { const h=Handlebars.create();registerLegacyHelpers(h);for(const [n,s] of Object.entries(partialSources))h.registerPartial(n,s);const fd=Object.fromEntries(schema.fields.map(f=>[f.name,sampleValue(f)]));const context=schema.templateKey===INDIVIDUAL_LICENSE_V3_KEY?buildIndividualLicenseV3Context({...fd,v3_conds:[{id:"audit",name:"製造販売",addon:true}],v3_lcs:[{material_code:"AUDIT-001",name:"構成要素",rates:{audit:"5"}}]}):buildRenderContext(fd);h.compile(htmlSource,{strict:false,noEscape:false})(context) } catch(error){renderError=error instanceof Error?error.message:String(error)}
 const status=renderError||missingHelpers.length||missingPartials.length?"error":schema.fields.length===0||unmappedVariables.length?"warning":"ok";
 return {templateKey:schema.templateKey,label:schema.label,fieldCount:schema.fields.length,status,variables,helpers,partials,missingHelpers,missingPartials,unmappedVariables,...(renderError?{renderError}:{})};
}
const cleanToken=(t:string)=>t.replace(/[()]/g,"").split("=")[0].trim();const unique=(v:string[])=>[...new Set(v)].sort();
function sampleValue(f:TemplateField):unknown{if(f.type==="boolean")return true;if(f.type==="number")return 1;if(f.type==="date")return"2026-07-28";if(f.type==="select")return f.options?.[0]??"選択値";return f.name}
function knownGeneratedVariable(k:string,v:string){if(k===INDIVIDUAL_LICENSE_V3_KEY)return new Set(["issueDate","contractNo","workId","masterAgreement","licensorName","licenseeName","startDate","licensorContact","licenseeContact","productDefinition","productName","exclusivity","maxRegion","maxLanguage","scope","conds","addonConds","showHolder","scopeColCount","rateColCount","licensorIsCorp","lcs","calcBaseRows","sublicensees","supervisor","specialExtras","licensorAddress","licensorRep","licenseeAddress","licenseeRep"]).has(v);return v.endsWith("_YEAR")||v.endsWith("_MONTH")||v.endsWith("_DAY")}
