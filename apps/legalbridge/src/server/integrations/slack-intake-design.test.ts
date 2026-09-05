import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentFormSchema } from "../../types.js";
import {
  selectableTemplatesForWorkflow,
  workflowForTemplate
} from "./slack-intake-design.js";
import {
  buildSlackIntakeModal,
  parseSlackIntakeSubmission
} from "./slack-intake-modal.js";

const templates:DocumentFormSchema[]=[
  {templateKey:"legal_response",templateVersionId:1,label:"法務評価書",fields:[]},
  {templateKey:"royalty_statement",templateVersionId:2,label:"利用許諾料計算書",fields:Array.from({length:64},(_,i)=>({name:"f"+i,label:"F"+i}))},
  {templateKey:"purchase_order",templateVersionId:3,label:"発注書",fields:[]},
  {templateKey:"license_master",templateVersionId:4,label:"ライセンス基本契約",fields:[]},
  {templateKey:"nda",templateVersionId:5,label:"秘密保持契約",fields:[]},
  {templateKey:"service_master",templateVersionId:6,label:"業務委託基本契約",fields:[]},
  {templateKey:"legal_freeform",templateVersionId:7,label:"汎用法務文書",fields:[]}
];

test("specialized templates route to their business workflow",()=>{
  assert.equal(workflowForTemplate("royalty_statement"),"license_settlement");
  assert.equal(workflowForTemplate("purchase_order"),"purchase_order");
  assert.equal(workflowForTemplate("license_master"),"license_contract");
  assert.equal(workflowForTemplate("legal_response"),"legal_review");
  assert.equal(workflowForTemplate("nda"),"document_create");
});

test("generic document selector excludes workflow-owned output templates",()=>{
  const keys=selectableTemplatesForWorkflow("document_create",templates).map(t=>t.templateKey);
  assert.deepEqual(keys,["nda","service_master","legal_freeform"]);
});

test("royalty settlement Slack modal asks event facts, not 64 template fields",()=>{
  const modal:any=buildSlackIntakeModal({workflow:"license_settlement",templates});
  const ids=modal.blocks.map((block:any)=>block.block_id).filter(Boolean);
  assert.ok(ids.includes("settlement_trigger_block"));
  assert.ok(ids.includes("target_document_number_block"));
  assert.ok(ids.includes("event_date_block"));
  assert.ok(ids.includes("work_hint_block"));
  assert.equal(ids.includes("template_block"),false);
  assert.equal(modal.blocks.some((block:any)=>String(block.block_id||"").startsWith("f")),false);
});

test("document creation modal derives its template options from active template catalog",()=>{
  const modal:any=buildSlackIntakeModal({
    workflow:"document_create",
    templates,
    initialTemplateKey:"legal_freeform"
  });
  const field=modal.blocks.find((block:any)=>block.block_id==="template_block");
  const options=field.element.options.map((option:any)=>option.value);
  assert.deepEqual(options,["nda","service_master","legal_freeform"]);
  assert.equal(field.element.initial_option.value,"legal_freeform");
});

test("license contract modal collects IN/OUT but leaves detailed rights terms to workspace",()=>{
  const modal:any=buildSlackIntakeModal({workflow:"license_contract",templates});
  const ids=modal.blocks.map((block:any)=>block.block_id);
  assert.ok(ids.includes("license_direction_block"));
  assert.ok(ids.includes("work_hint_block"));
  assert.equal(ids.includes("template_block"),false);
  assert.equal(ids.includes("royalty_rate_block"),false);
  assert.equal(ids.includes("territory_block"),false);
});

test("submission parser preserves workflow handoff facts",()=>{
  const parsed=parseSlackIntakeSubmission({
    view:{
      private_metadata:JSON.stringify({workflow:"license_settlement"}),
      state:{values:{
        workflow_block:{workflow_input:{selected_option:{value:"license_settlement"}}},
        summary_block:{summary_input:{value:"Sublicense receipt"}},
        deadline_block:{deadline_input:{selected_date:"2026-09-10"}},
        settlement_trigger_block:{settlement_trigger_input:{selected_option:{value:"sublicense_receipt"}}},
        target_document_number_block:{target_document_number_input:{value:"AL-CTR-2026-1"}},
        event_date_block:{event_date_input:{selected_date:"2026-09-05"}},
        work_hint_block:{work_hint_input:{value:"鰯と柊"}},
        details_block:{details_input:{value:"EURで入金"}}
      }}
    }
  });
  assert.equal(parsed.workflow,"license_settlement");
  assert.equal(parsed.settlementTrigger,"sublicense_receipt");
  assert.equal(parsed.targetDocumentNumber,"AL-CTR-2026-1");
  assert.equal(parsed.eventDate,"2026-09-05");
  assert.equal(parsed.workHint,"鰯と柊");
});
