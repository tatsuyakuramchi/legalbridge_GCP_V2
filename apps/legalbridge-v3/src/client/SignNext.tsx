import { useEffect, useState } from "react";
import { api } from "./api.js";
import { SendMany } from "./SendMany.js";

/*
 * 登録・取り込みの直後に、そのままクラウドサインの宛先入力へ進むための部品。
 * 取り込みの欄（DocumentImport）・作業台の「契約のみ」の段（ContractBand）・作業台の契約（DeskContracts）で使う。
 */

/**
 * 登録したらそのままクラウドサインで送れるか。送れるのは管理者だけで、連携が止まっていれば出さない。
 * 開いたときに一度だけ聞く（/integrations と /me）。
 */
export type Channel = { channel: string; mode: "off" | "dry_run" | "live"; configured: boolean };
export function useSignReady(open: boolean) {
  const [state, setState] = useState<{ channels: Channel[]; isAdmin: boolean } | null>(null);
  useEffect(() => {
    if (!open || state !== null) return;
    let live = true;
    Promise.all([
      api.get<{ channels: Channel[] }>("/integrations").then((r) => r.channels).catch(() => [] as Channel[]),
      api.get<{ user?: { role: string } }>("/me").then((r) => r.user === undefined || r.user.role === "admin").catch(() => false)
    ]).then(([channels, isAdmin]) => { if (live) setState({ channels, isAdmin }); });
    return () => { live = false; };
  }, [open]);
  const cloudsign = state?.channels.find((c) => c.channel === "cloudsign");
  return {
    channels: state?.channels ?? [],
    isAdmin: state?.isAdmin ?? false,
    canSign: Boolean(state?.isAdmin && cloudsign && cloudsign.mode !== "off")
  };
}

/** 送る画面に渡す文書。相手先は文書から引く（契約・条件・案件の相手先）。引けなければ署名者は手で入れる。 */
export type SignDoc = { id: number; documentNo: string | null; counterparty: string | null; imported?: boolean; storageUrl?: string | null };
export async function signDocOf(id: number, documentNo: string | null): Promise<SignDoc> {
  try {
    const d = await api.get<SignDoc>(`/documents/${id}`);
    return { id, documentNo: d.documentNo ?? documentNo, counterparty: d.counterparty ?? null, imported: true, storageUrl: d.storageUrl ?? null };
  } catch { return { id, documentNo, counterparty: null, imported: true }; }
}

/** 登録の直後に開くクラウドサインの送り先（SendMany をクラウドサインで開く）。 */
export function SignNext({ doc, channels, onFinish }: { doc: SignDoc; channels: Channel[]; onFinish: () => void }) {
  return (
    <SendMany key={doc.id} title={`${doc.documentNo ?? `#${doc.id}`} をクラウドサインで送る`}
      documents={[doc]} channels={channels} isAdmin initialWay="cloudsign" prefillSigners
      onDone={onFinish} onClose={onFinish} />
  );
}

/** 「登録したらそのままクラウドサインで送る」のチェック。 */
export function SignAfterField({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 6 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      登録したら、そのままクラウドサインで送る（署名者を入れる画面に進みます）
    </label>
  );
}
