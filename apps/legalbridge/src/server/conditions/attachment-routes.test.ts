import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  MemoryDocumentConditionAttachmentRepository,
  type DocumentConditionAttachmentContext
} from "./attachment-repository.js";
import { createDocumentConditionAttachmentRouter } from "./attachment-routes.js";

function app(writeEnabled=true){
  const context:DocumentConditionAttachmentContext={
    document:{
      id:10,documentNumber:"LEGACY-LIC-001",templateType:"license_master",
      title:"過去利用許諾契約",contractId:null,workId:null,materialId:null
    },
    conditions:[]
  };
  const repository=new MemoryDocumentConditionAttachmentRepository(
    new Map([[10,context]])
  );
  const server=express();
  server.use(express.json());
  server.use("/api/v2",createDocumentConditionAttachmentRouter(repository,writeEnabled));
  return {server,context};
}

test("legacy document can receive a work-linked IN license condition",async()=>{
  const {server,context}=app();
  const response=await request(server)
    .post("/api/v2/documents/10/condition-attachments")
    .send({
      mode:"create",
      workId:20,
      sourceMaterialId:30,
      flowDirection:"in",
      transactionKind:"license",
      conditionName:"製造時利用許諾料",
      paymentScheme:"royalty",
      currency:"JPY",
      ratePct:5
    });
  assert.equal(response.status,201);
  assert.equal(response.body.condition.workId,20);
  assert.equal(response.body.condition.flowDirection,"in");
  assert.equal(context.conditions.length,1);
});

test("OUT condition may be added with parent IN condition",async()=>{
  const {server}=app();
  const response=await request(server)
    .post("/api/v2/documents/10/condition-attachments")
    .send({
      mode:"create",
      workId:20,
      flowDirection:"out",
      transactionKind:"license",
      parentLicenseConditionId:99,
      conditionName:"ドイツ語版再許諾",
      paymentScheme:"royalty",
      currency:"EUR",
      ratePct:8
    });
  assert.equal(response.status,201);
  assert.equal(response.body.condition.parentLicenseConditionId,99);
});

test("write gate blocks retroactive attachment",async()=>{
  const {server}=app(false);
  const response=await request(server)
    .post("/api/v2/documents/10/condition-attachments")
    .send({
      mode:"create",workId:20,flowDirection:"in",
      transactionKind:"license",paymentScheme:"royalty"
    });
  assert.equal(response.status,403);
});

test("link_existing requires existing condition id",async()=>{
  const {server}=app();
  const response=await request(server)
    .post("/api/v2/documents/10/condition-attachments")
    .send({
      mode:"link_existing",workId:20,flowDirection:"in",
      transactionKind:"license",paymentScheme:"royalty"
    });
  assert.equal(response.status,400);
});
