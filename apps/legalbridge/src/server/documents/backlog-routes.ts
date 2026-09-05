import { Router } from "express";
import type { DocumentRegistryRepository } from "./registry-repository.js";
import type { TemplateRepository } from "./template-repository.js";
import {
  renderStoredDocumentHtml,
  StoredDocumentTemplateVersionError
} from "./document-html-renderer.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import {
  BacklogApiError,
  type BacklogWriteClient
} from "../integrations/backlog-web-api.js";

export function createDocumentBacklogRouter(
  documents: DocumentRegistryRepository,
  templates: TemplateRepository,
  pdfRenderer: PdfRenderer,
  client: BacklogWriteClient | null,
  liveWriteEnabled: boolean
) {
  const router = Router();

  router.get("/documents/:id/backlog", async (request, response, next) => {
    try {
      if (!client) {
        return response.status(503).json({
          error: "Backlog integration is not configured",
          code: "BACKLOG_UNAVAILABLE"
        });
      }
      const document = await findDocument(documents, request.params.id);
      const target = await resolveTarget(client, document.issueKey, document.documentNumber, document.id);
      return response.status(200).json({
        document: {
          id: document.id,
          documentNumber: document.documentNumber,
          templateType: document.templateType
        },
        ...target,
        mode: liveWriteEnabled ? "live" : "readonly"
      });
    } catch (error) {
      return handleBacklogError(error, response, next);
    }
  });

  router.post("/documents/:id/backlog/dispatch", async (request, response, next) => {
    try {
      if (!liveWriteEnabled || !client) {
        return response.status(503).json({
          error: "Backlog live dispatch is not enabled",
          code: "BACKLOG_LIVE_DISABLED"
        });
      }
      const role = response.locals.currentUser?.role;
      if (role !== "admin" && role !== "legal") {
        return response.status(403).json({
          error: "法務または管理者のみがBacklogへ文書を送信できます",
          code: "BACKLOG_DISPATCH_FORBIDDEN"
        });
      }

      const document = await findDocument(documents, request.params.id);
      const target = await resolveTarget(client, document.issueKey, document.documentNumber, document.id);
      if (target.existingAttachment) {
        return response.status(200).json({
          ok: true,
          reused: true,
          issue: target.issue,
          attachment: target.existingAttachment,
          comment: null
        });
      }

      const html = await renderStoredDocumentHtml(templates, document);
      if (!html) {
        return response.status(409).json({
          error: "current template render source is unavailable",
          code: "BACKLOG_DOCUMENT_NOT_RENDERABLE"
        });
      }
      const pdf = await pdfRenderer.render(html);
      const filename = attachmentFilename(document.documentNumber, document.id);
      const attachment = await client.uploadAttachment({
        filename,
        contentType: "application/pdf",
        data: pdf
      });
      const comment = await client.addIssueComment({
        issueIdOrKey: target.issue.issueKey,
        content: backlogComment(document.documentNumber, document.id),
        attachmentIds: [attachment.id]
      });

      return response.status(201).json({
        ok: true,
        reused: false,
        issue: target.issue,
        attachment,
        comment
      });
    } catch (error) {
      return handleBacklogError(error, response, next);
    }
  });

  return router;
}

async function findDocument(repository: DocumentRegistryRepository, rawId: string) {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new DocumentBacklogError("INVALID_DOCUMENT_ID", "invalid document id", 400);
  }
  const document = await repository.find(id);
  if (!document) {
    throw new DocumentBacklogError("DOCUMENT_NOT_FOUND", "document not found", 404);
  }
  if (!document.issueKey?.trim()) {
    throw new DocumentBacklogError(
      "BACKLOG_ISSUE_KEY_REQUIRED",
      "document has no Backlog issue key",
      422
    );
  }
  if (!document.documentNumber?.trim()) {
    throw new DocumentBacklogError(
      "DOCUMENT_NUMBER_REQUIRED",
      "finalized document number is required",
      422
    );
  }
  return document;
}

async function resolveTarget(
  client: BacklogWriteClient,
  issueKey: string,
  documentNumber: string | null,
  documentId: number
) {
  const [project, issue, attachments] = await Promise.all([
    client.getProject(),
    client.getIssue(issueKey),
    client.listIssueAttachments(issueKey)
  ]);
  if (issue.projectId !== project.id) {
    throw new DocumentBacklogError(
      "BACKLOG_PROJECT_MISMATCH",
      `issue ${issue.issueKey} does not belong to configured project ${project.projectKey}`,
      409
    );
  }
  const filename = attachmentFilename(documentNumber, documentId);
  const existingAttachment =
    attachments.find((attachment) => attachment.name === filename) ?? null;
  return {
    project,
    issue,
    attachmentFilename: filename,
    existingAttachment
  };
}

function attachmentFilename(documentNumber: string | null, documentId: number) {
  const base = (documentNumber ?? `document-${documentId}`)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 160) || `document-${documentId}`;
  return `${base}.pdf`;
}

function backlogComment(documentNumber: string | null, documentId: number) {
  return [
    "LegalBridge V2から確定文書を登録しました。",
    `文書番号: ${documentNumber ?? "未発番"}`,
    `LegalBridge Document ID: ${documentId}`
  ].join("\n");
}

class DocumentBacklogError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function handleBacklogError(
  error: unknown,
  response: import("express").Response,
  next: import("express").NextFunction
) {
  if (error instanceof DocumentBacklogError) {
    return response.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error instanceof StoredDocumentTemplateVersionError) {
    return response.status(409).json({
      error: error.message,
      code: "BACKLOG_DOCUMENT_TEMPLATE_VERSION_MISMATCH",
      storedTemplateVersionId: error.storedVersionId,
      currentTemplateVersionId: error.currentVersionId
    });
  }
  if (error instanceof BacklogApiError) {
    const status = error.status === 404 ? 422 : 502;
    const code = error.status === 404 ? "BACKLOG_ISSUE_NOT_FOUND" : "BACKLOG_API_ERROR";
    return response.status(status).json({ error: error.message, code, upstreamStatus: error.status });
  }
  return next(error);
}
