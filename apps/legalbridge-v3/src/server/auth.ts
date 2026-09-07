import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export type UserRole = "admin" | "legal" | "requester";
export interface AuthenticatedUser { email: string; role: UserRole; source: "disabled" | "iap" }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Locals { currentUser?: AuthenticatedUser } }
}

function roleFor(email: string): UserRole | null {
  const lower = email.toLowerCase();
  if (config.adminEmails.includes(lower)) return "admin";
  if (config.legalEmails.includes(lower)) return "legal";
  const domain = lower.split("@")[1] ?? "";
  if (config.requesterDomains.includes(domain)) return "requester";
  return null;
}

export function authenticate(request: Request, response: Response, next: NextFunction) {
  if (request.path === "/health") return next();
  // 内部の受信口はユーザー認証を通さない。各受信口が署名か共有シークレットで守る。
  if (request.path.startsWith("/internal/")) return next();

  if (config.authMode === "disabled") {
    response.locals.currentUser = { email: "dev@local", role: "admin", source: "disabled" };
    return next();
  }
  // IAP は署名済みヘッダを前段で検証する前提。ここではメールから役割だけを決める。
  const header = String(request.header("x-goog-authenticated-user-email") ?? "");
  const email = header.replace(/^accounts\.google\.com:/, "").trim();
  if (!email) return response.status(401).json({ error: "認証されていません" });
  const role = roleFor(email);
  if (!role) return response.status(403).json({ error: "利用が許可されていません", email });
  response.locals.currentUser = { email, role, source: "iap" };
  return next();
}

export function requireRole(...roles: UserRole[]) {
  return (_request: Request, response: Response, next: NextFunction) => {
    const user = response.locals.currentUser;
    if (!user) return response.status(401).json({ error: "認証されていません" });
    if (!roles.includes(user.role)) {
      return response.status(403).json({ error: "この操作の権限がありません", role: user.role });
    }
    return next();
  };
}

export function requireWritable(_request: Request, response: Response, next: NextFunction) {
  if (config.readOnly) {
    return response.status(503).json({ error: "読み取り専用モードで動作しています", code: "READ_ONLY" });
  }
  return next();
}
