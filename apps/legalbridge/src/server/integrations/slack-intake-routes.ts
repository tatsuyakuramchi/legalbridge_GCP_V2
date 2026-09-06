import { Router } from "express";
import { z } from "zod";
import type { TemplateRepository } from "../documents/template-repository.js";
import { buildSlackIntakeModal } from "./slack-intake-modal.js";
import {
  slackWorkflowCatalog,
  workflowDefinition,
  type SlackIntakeWorkflowId
} from "./slack-intake-design.js";

const workflowSchema=z.enum([
  "legal_review","document_create","license_contract","purchase_order",
  "delivery_inspection","license_settlement","deadline_change"
]);

export function createSlackIntakeDesignRouter(
  templates:TemplateRepository,
  options:{uploadUrl?:string}={}
){
  const router=Router();

  router.get("/slack-intake/catalog",async(_req,res,next)=>{
    try{
      return res.json({workflows:slackWorkflowCatalog(await templates.list())});
    }catch(error){next(error);}
  });

  router.get("/slack-intake/modal-preview",async(req,res,next)=>{
    try{
      const workflow=workflowSchema.catch("legal_review").parse(req.query.workflow);
      const templateKey=String(req.query.template_key ?? "").trim() || undefined;
      const allTemplates=await templates.list();
      return res.json({
        workflow:workflowDefinition(workflow),
        view:buildSlackIntakeModal({
          workflow:workflow as SlackIntakeWorkflowId,
          templates:allTemplates,
          initialTemplateKey:templateKey,
          uploadUrl:options.uploadUrl
        })
      });
    }catch(error){next(error);}
  });

  return router;
}
