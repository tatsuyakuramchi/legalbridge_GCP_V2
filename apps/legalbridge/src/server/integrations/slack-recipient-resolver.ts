export type SlackRecipientResolution =
  | "resolved"
  | "missing_identity"
  | "unmapped"
  | "ambiguous"
  | "invalid";

export interface SlackRecipientTarget {
  kind: "direct_message";
  resolution: SlackRecipientResolution;
  recipientEmailMasked: string | null;
  userId: string | null;
}

export interface SlackRecipientDirectory {
  resolve(email?: string | null): SlackRecipientTarget;
}

export function createSlackRecipientDirectory(raw?: string | null): SlackRecipientDirectory {
  const entries = new Map<string, string[]>();
  for (const item of String(raw ?? "").split(",")) {
    const [emailPart, userIdPart, ...extra] = item.split("=");
    if (!emailPart || !userIdPart || extra.length) continue;
    const email = normalizeEmail(emailPart);
    const userId = userIdPart.trim().toUpperCase();
    if (!email) continue;
    entries.set(email, [...(entries.get(email) ?? []), userId]);
  }

  return {
    resolve(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) {
        return target("missing_identity", null, null);
      }
      const matches = [...new Set(entries.get(normalized) ?? [])];
      if (!matches.length) {
        return target("unmapped", normalized, null);
      }
      if (matches.length > 1) {
        return target("ambiguous", normalized, null);
      }
      if (!/^[UW][A-Z0-9]{8,}$/.test(matches[0])) {
        return target("invalid", normalized, null);
      }
      return target("resolved", normalized, matches[0]);
    }
  };
}

function target(
  resolution: SlackRecipientResolution,
  email: string | null,
  userId: string | null
): SlackRecipientTarget {
  return {
    kind: "direct_message",
    resolution,
    recipientEmailMasked: email ? maskEmail(email) : null,
    userId
  };
}

function normalizeEmail(value?: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}
