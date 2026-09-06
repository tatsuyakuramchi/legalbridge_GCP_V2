import { Router } from "express";
import { z } from "zod";
import {
  ConditionAttachmentError,
  type DocumentConditionAttachmentRepository
} from "./attachment-repository.js";

const attachSchema=z.object({
  mode:z.enum(["create","link_existing"]).default("create"),
  existingConditionLineId:z.coerce.number().int().positive().optional(),
  workId:z.coerce.number().int().positive(),
  sourceWorkId:z.coerce.number().int().positive().optional(),
  sourceMaterialId:z.coerce.number().int().positive().optional(),
  contractId:z.coerce.number().int().positive().optional(),
  parentLicenseConditionId:z.coerce.number().int().positive().optional(),
  counterpartyVendorId:z.coerce.number().int().positive().optional(),
  conditionName:z.string().trim().max(500).optional(),
  flowDirection:z.enum(["in","out"]),
  transactionKind:z.string().trim().min(1).max(50).default("license"),
  paymentScheme:z.string().trim().max(50).optional(),
  calcType:z.string().trim().max(50).optional(),
  currency:z.string().trim().min(3).max(10).optional(),
  ratePct:z.coerce.number().min(0).max(100).optional(),
  amountExTax:z.coerce.number().optional(),
  mgAmount:z.coerce.number().min(0).optional(),
  agAmount:z.coerce.number().min(0).optional(),
  termStart:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  termEnd:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  territory:z.string().trim().max(500).optional(),
  languages:z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  exclusivity:z.string().trim().max(100).optional(),
  sublicenseAllowed:z.boolean().optional(),
  royaltyBase:z.string().trim().max(1000).optional(),
  deductibleCosts:z.string().trim().max(1000).optional(),
  notes:z.string().trim().max(5000).optional()
}).superRefine((value,ctx)=>{
  if(value.mode==="link_existing" && !value.existingConditionLineId){
    ctx.addIssue({code:"custom",path:["existingConditionLineId"],message:"existingConditionLineId is required"});
  }
  if(value.termStart && value.termEnd && value.termEnd < value.termStart){
    ctx.addIssue({code:"custom",path:["termEnd"],message:"termEnd must be on or after termStart"});
  }
});

export function createDocumentConditionAttachmentRouter(
  repository:DocumentConditionAttachmentRepository|undefined,
  writeEnabled:boolean
){
  const router=Router();

  router.get("/documents/:id/condition-attachments",async(req,res,next)=>{
    try{
      if(!repository) return res.status(503).json({error:"condition attachment repository is unavailable"});
      const id=z.coerce.number().int().positive().parse(req.params.id);
      const context=await repository.context(id);
      if(!context) return res.status(404).json({error:"document not found",code:"DOCUMENT_NOT_FOUND"});
      return res.json(context);
    }catch(error){
      if(error instanceof z.ZodError) return res.status(400).json({error:"invalid request",issues:error.issues});
      next(error);
    }
  });

  router.post("/documents/:id/condition-attachments",async(req,res,next)=>{
    try{
      if(!writeEnabled) return res.status(403).json({error:"condition attachment writes are disabled",code:"WRITE_SCOPE_DISABLED"});
      if(!repository) return res.status(503).json({error:"condition attachment repository is unavailable"});
      const id=z.coerce.number().int().positive().parse(req.params.id);
      const input=attachSchema.parse(req.body);
      const result=await repository.attach(id,input);
      return res.status(201).json(result);
    }catch(error){
      if(error instanceof ConditionAttachmentError){
        const status=error.code.endsWith("_NOT_FOUND") ? 404 : 409;
        return res.status(status).json({error:error.message,code:error.code});
      }
      if(error instanceof z.ZodError) return res.status(400).json({error:"invalid request",issues:error.issues});
      next(error);
    }
  });

  return router;
}
