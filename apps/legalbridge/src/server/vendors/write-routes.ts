import { Router } from "express";
import { z } from "zod";
import { vendorCreateSchema, vendorUpdateSchema } from "./write-schema.js";
import { VendorWriteError, type VendorWriteRepository } from "./write-repository.js";

const idPath = z.object({ id: z.coerce.number().int().positive() });

function editorAllowed(role: string | undefined) {
  return role === "admin" || role === "legal";
}
function statusFor(code: string) {
  if (code === "VENDOR_NOT_FOUND") return 404;
  if (code === "VENDOR_CONFLICT") return 409;
  if (code === "VENDOR_REQUIRED") return 422;
  return 400;
}

export function createVendorWriteRouter(
  vendors: VendorWriteRepository | undefined,
  writeEnabled = false
) {
  const router = Router();

  router.post("/vendors/validate", (request, response) => {
    const result = vendorCreateSchema.safeParse(request.body);
    if (!result.success) {
      return response.status(400).json({
        ok: false,
        errors: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }))
      });
    }
    return response.status(200).json({ ok: true });
  });

  // Raw vendor for the edit form (admin/legal via createApiAuthorization).
  router.get("/vendors/:id", async (request, response, next) => {
    try {
      if (!vendors) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const record = await vendors.find(id);
      if (!record) {
        return response.status(404).json({ error: "指定した取引先が見つかりません", code: "VENDOR_NOT_FOUND" });
      }
      return response.status(200).json({ vendor: record });
    } catch (error) {
      return handle(error, response, next);
    }
  });

  router.post("/vendors", async (request, response, next) => {
    try {
      if (!writeEnabled || !vendors) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const input = vendorCreateSchema.parse(request.body);
      const created = await vendors.createVendor(input, response.locals.currentUser!.email);
      return response.status(201).json(created);
    } catch (error) {
      return handle(error, response, next);
    }
  });

  router.patch("/vendors/:id", async (request, response, next) => {
    try {
      if (!writeEnabled || !vendors) return unavailable(response);
      if (!editorAllowed(response.locals.currentUser?.role)) return forbidden(response);
      const { id } = idPath.parse(request.params);
      const input = vendorUpdateSchema.parse(request.body);
      const updated = await vendors.updateVendor(id, input);
      return response.status(200).json(updated);
    } catch (error) {
      return handle(error, response, next);
    }
  });

  return router;
}

function unavailable(response: import("express").Response) {
  return response.status(503).json({ error: "vendor editing is not enabled", code: "VENDOR_WRITE_UNAVAILABLE" });
}
function forbidden(response: import("express").Response) {
  return response.status(403).json({ error: "法務または管理者のみが取引先を編集できます", code: "VENDOR_EDIT_FORBIDDEN" });
}
function handle(error: unknown, response: import("express").Response, next: import("express").NextFunction) {
  if (error instanceof VendorWriteError) {
    return response.status(statusFor(error.code)).json({ error: error.message, code: error.code });
  }
  if (error instanceof z.ZodError) {
    return response.status(400).json({ error: "invalid request", issues: error.issues });
  }
  return next(error);
}
