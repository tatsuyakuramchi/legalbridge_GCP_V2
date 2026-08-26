import type { NextFunction, Request, Response } from "express";

export type UserRole = "admin" | "legal" | "requester";

export interface AuthenticatedUser {
  email: string;
  subject: string;
  role: UserRole;
  source: "disabled" | "iap" | "cloudrun-iam";
}

export interface AuthSettings {
  mode: "disabled" | "iap" | "cloudrun-iam";
  adminEmails: Set<string>;
  legalEmails: Set<string>;
  requesterDomains: Set<string>;
}

declare global {
  namespace Express {
    interface Locals {
      currentUser?: AuthenticatedUser;
    }
  }
}

/**
 * 認証ミドルウェア。
 * publicPathPrefixes に挙げたパス配下は認証を通さずに公開する（社外向けページ用）。
 * 既定は空で、従来どおり /health 以外はすべて認証対象。
 */
export function createAuthentication(settings: AuthSettings, publicPathPrefixes: string[] = []) {
  const publicPrefixes = publicPathPrefixes
    .map((prefix) => String(prefix ?? "").trim())
    .filter((prefix) => prefix.length > 1 && prefix.startsWith("/"));
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.path === "/health") return next();
    if (publicPrefixes.some((prefix) =>
      request.path === prefix || request.path.startsWith(prefix + "/")
    )) return next();

    if (settings.mode === "disabled") {
      response.locals.currentUser = {
        email: "system@local",
        subject: "disabled-auth",
        role: "admin",
        source: "disabled"
      };
      return next();
    }

    if (settings.mode === "cloudrun-iam") {
      const [email, ...additionalAdmins] = settings.adminEmails;
      if (!email || additionalAdmins.length > 0) {
        return response.status(503).json({
          error: "Cloud Run IAM validation requires exactly one configured administrator",
          code: "AUTHENTICATION_CONFIGURATION_INVALID"
        });
      }
      response.locals.currentUser = {
        email,
        subject: "cloudrun-iam-upstream",
        role: "admin",
        source: "cloudrun-iam"
      };
      return next();
    }

    const email = normalizeIapHeader(request.header("x-goog-authenticated-user-email"));
    const subject = normalizeIapHeader(request.header("x-goog-authenticated-user-id"));
    if (!email || !subject) {
      return response.status(401).json({
        error: "authenticated Google identity is required",
        code: "AUTHENTICATION_REQUIRED"
      });
    }

    const role = resolveRole(email, settings);
    if (!role) {
      return response.status(403).json({
        error: "this account is not authorized for LegalBridge",
        code: "ACCOUNT_NOT_AUTHORIZED"
      });
    }

    response.locals.currentUser = { email, subject, role, source: "iap" };
    next();
  };
}

export function createApiAuthorization() {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.path.startsWith("/api/v2")) return next();
    const user = response.locals.currentUser;
    if (!user) {
      return response.status(401).json({
        error: "authentication context is missing",
        code: "AUTHENTICATION_REQUIRED"
      });
    }
    const apiPath = request.path.slice("/api/v2".length) || "/";
    if (isAllowed(user.role, request.method, apiPath)) return next();
    return response.status(403).json({
      error: "your role cannot access this operation",
      code: "ROLE_FORBIDDEN",
      role: user.role
    });
  };
}

export function publicUser(user: AuthenticatedUser) {
  return {
    email: user.email,
    role: user.role,
    source: user.source
  };
}

function resolveRole(email: string, settings: AuthSettings): UserRole | null {
  if (settings.adminEmails.has(email)) return "admin";
  if (settings.legalEmails.has(email)) return "legal";
  const domain = email.split("@")[1] ?? "";
  if (settings.requesterDomains.has(domain)) return "requester";
  return null;
}

function isAllowed(role: UserRole, method: string, path: string) {
  if (role === "admin") return true;
  if (path === "/me" || path === "/runtime") return true;
  if (role === "legal") return !path.startsWith("/admin");
  if (method === "GET" && path === "/dashboard") return true;
  if (method === "GET" && (
    path === "/document-form-context" ||
    path === "/document-drafts" ||
    /^\/document-drafts\/[^/]+$/.test(path) ||
    path === "/documents" ||
    /^\/documents\/\d+$/.test(path)
  )) return true;
  if (["PUT", "DELETE"].includes(method) && /^\/document-drafts\/[^/]+$/.test(path)) return true;
  if (method === "GET" && (
    path === "/document-templates" ||
    path.startsWith("/document-templates/")
  )) return true;
  if (method === "POST" && (
    path === "/documents/validate" ||
    path === "/documents/preview"
  )) return true;
  return false;
}

function normalizeIapHeader(value: string | undefined) {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf(":");
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
}
