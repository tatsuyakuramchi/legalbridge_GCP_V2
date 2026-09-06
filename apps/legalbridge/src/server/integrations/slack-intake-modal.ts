import type { DocumentFormSchema } from "../../types.js";
import {
  selectableTemplatesForWorkflow,
  slackIntakeWorkflowDefinitions,
  workflowDefinition,
  type SlackIntakeWorkflowId
} from "./slack-intake-design.js";

export interface SlackModalOptions {
  workflow?: SlackIntakeWorkflowId;
  templates?: DocumentFormSchema[];
  issueCandidates?: Array<{ issueKey: string; summary: string; counterparty?: string | null }>;
  initialTemplateKey?: string;
  uploadUrl?: string;
}

export interface SlackIntakeSubmission {
  workflow: SlackIntakeWorkflowId;
  templateKey: string | null;
  summary: string;
  deadline: string | null;
  counterparty: string | null;
  details: string;
  licenseDirection: "in" | "out" | null;
  workHint: string | null;
  targetDocumentNumber: string | null;
  eventDate: string | null;
  settlementTrigger: "manufacturing" | "sale" | "sublicense_receipt" | null;
  targetIssueKey: string | null;
  newDeadline: string | null;
  changeReason: string | null;
}

export function buildSlackIntakeModal(options: SlackModalOptions = {}) {
  const workflow = workflowDefinition(options.workflow);
  const templates = selectableTemplatesForWorkflow(workflow.id, options.templates ?? []);
  const blocks:any[] = [workflowSelect(workflow.id)];

  blocks.push({
    type:"context",
    block_id:"workflow_help_block",
    elements:[{type:"mrkdwn",text:workflow.description}]
  });

  if (workflow.id === "deadline_change") {
    blocks.push(...deadlineChangeBlocks(options.issueCandidates ?? []));
    blocks.push(uploadLinkBlock(options.uploadUrl));
    return modal(workflow.label, blocks, { workflow: workflow.id });
  }

  if (workflow.templateSelection !== "none") {
    if (templates.length) {
      blocks.push(templateSelect(templates, options.initialTemplateKey));
    } else {
      blocks.push({
        type:"context",
        block_id:"template_unavailable_block",
        elements:[{type:"mrkdwn",text:"⚠️ 利用可能なTemplateを取得できません。Template設定を確認してください。"}]
      });
    }
  }

  if (workflow.slackFields.includes("summary")) {
    blocks.push(inputText(
      "summary_block","summary_input","件名",
      "例：〇〇社との契約書を新規作成",false
    ));
  }

  if (workflow.slackFields.includes("deadline")) {
    blocks.push({
      type:"input",
      block_id:"deadline_block",
      optional:true,
      label:{type:"plain_text",text:"希望納期"},
      element:{type:"datepicker",action_id:"deadline_input"}
    });
  }

  if (workflow.slackFields.includes("counterparty")) {
    blocks.push(inputText(
      "counterparty_block","counterparty_input","相手方名称（分かる範囲）",
      "既存マスタとの正式な紐付けはLegalBridgeで行います。",true
    ));
  }

  if (workflow.id === "license_contract") {
    blocks.push({
      type:"input",
      block_id:"license_direction_block",
      label:{type:"plain_text",text:"契約方向"},
      element:{
        type:"radio_buttons",
        action_id:"license_direction_input",
        options:[
          {text:{type:"plain_text",text:"IN：当社が権利を取得"},value:"in"},
          {text:{type:"plain_text",text:"OUT：当社から利用許諾"},value:"out"}
        ]
      }
    });
  }

  if (workflow.slackFields.includes("settlement_trigger")) {
    blocks.push({
      type:"input",
      block_id:"settlement_trigger_block",
      label:{type:"plain_text",text:"何が発生しましたか"},
      element:{
        type:"radio_buttons",
        action_id:"settlement_trigger_input",
        options:[
          {text:{type:"plain_text",text:"製造した"},value:"manufacturing"},
          {text:{type:"plain_text",text:"販売実績が発生した"},value:"sale"},
          {text:{type:"plain_text",text:"サブライセンス料が入金された"},value:"sublicense_receipt"}
        ]
      }
    });
  }

  if (workflow.slackFields.includes("target_document_number")) {
    blocks.push(inputText(
      "target_document_number_block","target_document_number_input",
      workflow.id === "delivery_inspection" ? "対象の発注書・契約番号" : "対象の契約番号（分かる場合）",
      "番号が不明でも送信できます。LegalBridgeで作品・契約から選択できます。",true
    ));
  }

  if (workflow.slackFields.includes("event_date")) {
    blocks.push({
      type:"input",
      block_id:"event_date_block",
      optional:true,
      label:{type:"plain_text",text:workflow.id === "license_settlement" ? "発生日・入金日" : "納品日"},
      element:{type:"datepicker",action_id:"event_date_input"}
    });
  }

  if (workflow.slackFields.includes("work_hint")) {
    blocks.push(inputText(
      "work_hint_block","work_hint_input","対象作品（分かる範囲）",
      "正式な作品マスタ選択・権利ソース選択はLegalBridgeで行います。",true
    ));
  }

  blocks.push(uploadLinkBlock(options.uploadUrl));

  if (workflow.slackFields.includes("details")) {
    blocks.push({
      type:"input",
      block_id:"details_block",
      optional: workflow.id !== "legal_review",
      label:{type:"plain_text",text:workflow.id === "legal_review" ? "相談・レビュー内容" : "依頼概要・補足"},
      element:{
        type:"plain_text_input",
        action_id:"details_input",
        multiline:true,
        placeholder:{type:"plain_text",text:detailPlaceholder(workflow.id)}
      }
    });
  }

  if (workflow.completionMode === "request_then_workspace") {
    blocks.push({
      type:"context",
      block_id:"handoff_help_block",
      elements:[{
        type:"mrkdwn",
        text:"送信後、Requestを作成します。契約条件・支払条件・権利条件などの詳細はLegalBridgeの専用画面で入力します。SlackとTemplateに同じ項目を二重入力する必要はありません。"
      }]
    });
  }

  return modal("法務依頼", blocks, {
    workflow: workflow.id,
    template_key: selectedTemplateKey(templates, options.initialTemplateKey)
  });
}

export function parseSlackIntakeSubmission(payload:any):SlackIntakeSubmission {
  const values=payload?.view?.state?.values ?? {};
  const text=(block:string,action:string)=>{
    const value=values?.[block]?.[action]?.value;
    return value === undefined || value === null ? "" : String(value).trim();
  };
  const date=(block:string,action:string)=>{
    const value=values?.[block]?.[action]?.selected_date;
    return value ? String(value) : null;
  };
  const option=(block:string,action:string)=>{
    const field=values?.[block]?.[action];
    return field?.selected_option?.value
      ?? field?.selected_options?.[0]?.value
      ?? null;
  };
  let meta:any={};
  try { meta=JSON.parse(payload?.view?.private_metadata ?? "{}"); } catch { meta={}; }
  const workflow=workflowDefinition(option("workflow_block","workflow_input") ?? meta.workflow).id;
  const licenseDirection=option("license_direction_block","license_direction_input");
  const trigger=option("settlement_trigger_block","settlement_trigger_input");
  return {
    workflow,
    templateKey: option("template_block","template_input") ?? meta.template_key ?? null,
    summary:text("summary_block","summary_input"),
    deadline:date("deadline_block","deadline_input"),
    counterparty:text("counterparty_block","counterparty_input") || null,
    details:text("details_block","details_input"),
    licenseDirection:licenseDirection === "in" || licenseDirection === "out" ? licenseDirection : null,
    workHint:text("work_hint_block","work_hint_input") || null,
    targetDocumentNumber:text("target_document_number_block","target_document_number_input") || null,
    eventDate:date("event_date_block","event_date_input"),
    settlementTrigger:
      trigger === "manufacturing" || trigger === "sale" || trigger === "sublicense_receipt"
        ? trigger : null,
    targetIssueKey:
      option("target_issue_select_block","target_issue_select_input")
      || text("target_issue_block","target_issue_input")
      || null,
    newDeadline:date("new_deadline_block","new_deadline_input"),
    changeReason:text("change_reason_block","change_reason_input") || null
  };
}

function modal(title:string,blocks:any[],metadata:Record<string,unknown>){
  return {
    type:"modal",
    callback_id:"legalbridge_v2_intake",
    title:{type:"plain_text",text:title.slice(0,24)},
    submit:{type:"plain_text",text:"送信"},
    close:{type:"plain_text",text:"キャンセル"},
    private_metadata:JSON.stringify(metadata),
    blocks
  };
}

function workflowSelect(selected:SlackIntakeWorkflowId){
  const groups=Object.entries(
    slackIntakeWorkflowDefinitions.reduce<Record<string,typeof slackIntakeWorkflowDefinitions>>((acc,item)=>{
      (acc[item.group]??=[]).push(item);
      return acc;
    },{})
  ).map(([label,items])=>({
    label:{type:"plain_text",text:label},
    options:items.map(item=>({
      text:{type:"plain_text",text:item.label},
      value:item.id
    }))
  }));
  const current=workflowDefinition(selected);
  return {
    type:"input",
    block_id:"workflow_block",
    dispatch_action:true,
    label:{type:"plain_text",text:"依頼内容"},
    element:{
      type:"static_select",
      action_id:"workflow_input",
      initial_option:{text:{type:"plain_text",text:current.label},value:current.id},
      option_groups:groups
    }
  };
}

function templateSelect(templates:DocumentFormSchema[],initialTemplateKey?:string){
  const selected=templates.find(t=>t.templateKey===initialTemplateKey) ?? templates[0];
  const element:any={
    type:"static_select",
    action_id:"template_input",
    placeholder:{type:"plain_text",text:"作成する文書Templateを選択"},
    options:templates.slice(0,100).map(template=>({
      text:{type:"plain_text",text:template.label.slice(0,75)},
      value:template.templateKey
    }))
  };
  if(selected){
    element.initial_option={
      text:{type:"plain_text",text:selected.label.slice(0,75)},
      value:selected.templateKey
    };
  }
  return {
    type:"input",
    block_id:"template_block",
    label:{type:"plain_text",text:"作成する文書"},
    element
  };
}

function deadlineChangeBlocks(candidates:Array<{issueKey:string;summary:string;counterparty?:string|null}>){
  const blocks:any[]=[];
  if(candidates.length){
    blocks.push({
      type:"input",
      block_id:"target_issue_select_block",
      optional:true,
      label:{type:"plain_text",text:"対象依頼（候補）"},
      element:{
        type:"static_select",
        action_id:"target_issue_select_input",
        options:candidates.slice(0,25).map(candidate=>({
          text:{type:"plain_text",text:(
            candidate.issueKey+" "+candidate.summary+
            (candidate.counterparty?" / "+candidate.counterparty:"")
          ).slice(0,75)},
          value:candidate.issueKey
        }))
      }
    });
  }
  blocks.push(
    inputText("target_issue_block","target_issue_input","Backlog課題キー（候補にない場合）","例：LEGAL-123",candidates.length>0),
    {
      type:"input",block_id:"new_deadline_block",
      label:{type:"plain_text",text:"新しい納期"},
      element:{type:"datepicker",action_id:"new_deadline_input"}
    },
    {
      type:"input",block_id:"change_reason_block",
      label:{type:"plain_text",text:"変更理由"},
      element:{type:"plain_text_input",action_id:"change_reason_input",multiline:true}
    }
  );
  return blocks;
}

function uploadLinkBlock(uploadUrl?:string){
  const safeUrl=String(uploadUrl ?? "").trim();
  return {
    type:"context",
    block_id:"attachment_upload_block",
    elements:[{
      type:"mrkdwn",
      text:safeUrl
        ? "📎 *資料添付*: <"+safeUrl+"|資料アップロードページを開く>\n契約書・見積書・メールPDF・参考資料などをここから追加できます。"
        : "📎 *資料添付*: 受付後のDMに表示される「資料アップロード」リンクから追加できます。"
    }]
  };
}

function inputText(
  blockId:string,actionId:string,label:string,placeholder:string,optional:boolean
){
  return {
    type:"input",block_id:blockId,optional,
    label:{type:"plain_text",text:label},
    element:{
      type:"plain_text_input",action_id:actionId,
      placeholder:{type:"plain_text",text:placeholder}
    }
  };
}

function selectedTemplateKey(templates:DocumentFormSchema[],initial?:string){
  return templates.find(t=>t.templateKey===initial)?.templateKey
    ?? templates[0]?.templateKey
    ?? null;
}

function detailPlaceholder(workflow:SlackIntakeWorkflowId){
  switch(workflow){
    case "legal_review": return "確認してほしい点・背景・懸念点を記載してください。";
    case "document_create": return "文書の目的、相手方との関係、特に入れたい条件等。";
    case "license_contract": return "作品、取引背景、IN/OUTの概要等。詳細条件はLegalBridgeで入力します。";
    case "purchase_order": return "何を誰に依頼する発注かを簡潔に記載。金銭・権利明細はLegalBridgeで入力します。";
    case "delivery_inspection": return "今回の納品内容・検収上の補足。";
    case "license_settlement": return "製造・販売・入金の概要。金額と条件はLegalBridgeで確認・計算します。";
    case "deadline_change": return "";
  }
}
