import { promises as dns } from "node:dns";

/**
 * メールが届くドメインか（MX か A/AAAA があるか）を先に確かめる。
 *
 * CloudSign は届かないドメインの宛先を "invalid value for email" で断る。断られるのは
 * 下書きを作ったあと（宛先を入れる段）なので、宛先の無い下書きが残ってしまう。
 * 作る前に見て、どのアドレスが悪いかを言う。DNS が引けない（ネットワークの都合）
 * ときは止めない（確かめられないことを理由に送れなくしない）。
 */
export interface DomainResolver {
  mx(domain: string): Promise<unknown[]>;
  a(domain: string): Promise<unknown[]>;
}

const systemResolver: DomainResolver = {
  mx: (d) => dns.resolveMx(d),
  a: async (d) => {
    const v4 = await dns.resolve4(d).catch(() => [] as string[]);
    return v4.length ? v4 : dns.resolve6(d).catch(() => [] as string[]);
  }
};

/** 「無い」と言い切れるエラー。これ以外（タイムアウト等）は確かめられなかった扱い。 */
const ABSENT = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);

/** 届かないと分かったアドレスを返す（重複なし・入力の順）。 */
export async function undeliverableEmails(emails: string[], resolver: DomainResolver = systemResolver, timeoutMs = 3000): Promise<string[]> {
  const byDomain = new Map<string, boolean>();
  const out: string[] = [];
  for (const email of [...new Set(emails.map((e) => e.trim()).filter(Boolean))]) {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    if (!byDomain.has(domain)) {
      let ok = true;
      try {
        const mx = await withTimeout(resolver.mx(domain), timeoutMs);
        ok = mx.length > 0;
      } catch (e) {
        if (!ABSENT.has(String((e as { code?: string }).code))) { byDomain.set(domain, true); continue; }
        ok = false;
      }
      if (!ok) {
        // MX が無くても A/AAAA があれば届く（RFC 5321 の暗黙の MX）。
        try { ok = (await withTimeout(resolver.a(domain), timeoutMs)).length > 0; }
        catch (e) { ok = !ABSENT.has(String((e as { code?: string }).code)); }
      }
      byDomain.set(domain, ok);
    }
    if (!byDomain.get(domain)) out.push(email);
  }
  return out;
}
