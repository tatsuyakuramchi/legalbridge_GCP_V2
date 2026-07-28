import Handlebars from "handlebars";
import type { DocumentFormSchema, TemplateField } from "../../types.js";
import { buildIndividualLicenseV3Context, INDIVIDUAL_LICENSE_V3_KEY } from "./individual-license-v3.js";
import { buildRenderContext, registerLegacyHelpers } from "./rendering.js";

const BUILTIN_HELPERS = new Set(["if", "unless", "each", "with", "lookup", "log"]);
const REGISTERED_HELPERS = new Set(["eq","ne","formatCurrency","formatDate","formatDateCompact","add","multiply","index1","circledNum","formatPct","formatYen","formatMoney","or","gt","lt","join","length","concat","cycleLabel","invoiceLabel","cycleLabelEn","billingDayLabel","billingDayLabelEn"]);
export interface TemplateCompatibilityResult { templateKey:string; label:string; fieldCount:number; status:"ok"|"warning"|"error"; variables:string[]; helpers:string[]; partials:string[]; missingHelpers:string[]; missingPartials:string[]; unmappedVariables:string[]; renderError?:string }
export function inspectTemplateCompatibility(schema:DocumentFormSchema, htmlSource:string, partialSources:Record<string,string>):TemplateCompatibilityResult {
 const {variables,helpers,partials}=analyzeExpressions(htmlSource);
 const missingHelpers=helpers.filter(h=>!BUILTIN_HELPERS.has(h)&&!REGISTERED_HELPERS.has(h));
 const missingPartials=partials.filter(p=>!(p in partialSources));
 const fieldNames=new Set(schema.fields.map(f=>f.name));
 const unmappedVariables=variables.filter(v=>{const root=v.split(/[.[\]]/,1)[0];return root&&!fieldNames.has(root)&&!knownGeneratedVariable(schema.templateKey,root)});
 let renderError:string|undefined;
 try{const h=Handlebars.create();registerLegacyHelpers(h);for(const[n,s]of Object.entries(partialSources))h.registerPartial(n,s);const fd=Object.fromEntries(schema.fields.map(f=>[f.name,sampleValue(f)]));const context=schema.templateKey===INDIVIDUAL_LICENSE_V3_KEY?buildIndividualLicenseV3Context({...fd,v3_conds:[{id:"audit",name:"製造販売",addon:true}],v3_lcs:[{material_code:"AUDIT-001",name:"構成要素",rates:{audit:"5"}}]}):buildRenderContext(fd);h.compile(htmlSource,{strict:false,noEscape:false})(context)}catch(error){renderError=error instanceof Error?error.message:String(error)}
 const status=renderError||missingHelpers.length||missingPartials.length?"error":schema.fields.length===0||unmappedVariables.length?"warning":"ok";
 return{templateKey:schema.templateKey,label:schema.label,fieldCount:schema.fields.length,status,variables,helpers,partials,missingHelpers,missingPartials,unmappedVariables,...(renderError?{renderError}:{})};
}
function analyzeExpressions(htmlSource:string){
 const variables:string[]=[];const helpers:string[]=[];const partials:string[]=[];const scopes:string[]=[];
 const expressions=[...htmlSource.matchAll(/{{{?\s*([^{}!][^{}]*?)\s*}?}}/g)].map(m=>m[1].trim()).filter(Boolean);
 for(const expression of expressions){
  if(expression.startsWith("/")){if(["/each","/with"].some(x=>expression.startsWith(x)))scopes.pop();continue}
  if(expression==="else"||expression.startsWith("else "))continue;
  if(expression.startsWith(">")){partials.push(expression.slice(1).trim().split(/\s+/)[0]);continue}
  const block=expression.match(/^#(each|with)\s+([^\s]+)/);
  if(block){if(scopes.length===0)addVariable(variables,block[2]);scopes.push(block[1]);continue}
  const clean=expression.replace(/^[#^]/,"").trim();
  const withoutStrings=clean.replace(/"[^"]*"|'[^']*'/g," ");
  const tokens=withoutStrings.match(/[A-Za-z_\u3000-\u9fff][\w.\-[\]\u3000-\u9fff]*/g)??[];
  const first=tokens[0]??"";
  const isHelper=tokens.length>1||BUILTIN_HELPERS.has(first)||REGISTERED_HELPERS.has(first);
  if(isHelper&&first)helpers.push(first);
  for(const sub of clean.matchAll(/\(([A-Za-z_][\w]*)\b/g))helpers.push(sub[1]);
  if(scopes.length>0)continue;
  const values=isHelper?tokens.slice(1):tokens;
  for(const token of values){if(BUILTIN_HELPERS.has(token)||REGISTERED_HELPERS.has(token)||["true","false","null","undefined","this"].includes(token))continue;addVariable(variables,token)}
 }
 return{variables:unique(variables),helpers:unique(helpers),partials:unique(partials)};
}
function addVariable(target:string[],raw:string){const token=raw.replace(/^\.\.\//,"").replace(/[()]/g,"").split("=")[0].trim();if(token&&!token.startsWith("@")&&!token.startsWith(".")&&!/^['"\d]/.test(token))target.push(token)}
const unique=(v:string[])=>[...new Set(v)].sort();
function sampleValue(f:TemplateField):unknown{if(f.type==="boolean")return true;if(f.type==="number")return 1;if(f.type==="date")return"2026-07-28";if(f.type==="select")return f.options?.[0]??"選択値";return f.name}
function knownGeneratedVariable(k:string,v:string){if(k===INDIVIDUAL_LICENSE_V3_KEY)return new Set(["issueDate","contractNo","workId","masterAgreement","licensorName","licenseeName","startDate","licensorContact","licenseeContact","productDefinition","productName","exclusivity","maxRegion","maxLanguage","scope","conds","addonConds","showHolder","scopeColCount","rateColCount","licensorIsCorp","lcs","calcBaseRows","sublicensees","supervisor","specialExtras","licensorAddress","licensorRep","licenseeAddress","licenseeRep"]).has(v);return v.endsWith("_YEAR")||v.endsWith("_MONTH")||v.endsWith("_DAY")}
