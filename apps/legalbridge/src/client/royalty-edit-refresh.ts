import type { DocumentFormData } from "../types";

type ProductPreview = {
  productName: string;
  transactionModelName: string;
  licenseTerritory: string;
  licenseLanguage: string;
  licenseScopeSource: "in" | "out";
};

type ConditionCandidate = {
  id: number;
  direction: string | null;
  parentLicenseConditionId: number | null;
  counterparty: string | null;
};

export type RoyaltyEditRefreshResult = {
  formData: DocumentFormData;
  changed: boolean;
  message: string;
};

const positiveId = (value: unknown) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * 編集開始時だけ、保存済み計算書の製品名を現在の条件DBから再構築する。
 * DB保存は呼出側の「下書き保存 / 再発行」まで行わない。
 */
export async function refreshRoyaltyProductForEdit(
  formData: DocumentFormData,
  fetcher: typeof fetch = fetch
): Promise<RoyaltyEditRefreshResult> {
  const inboundId = positiveId(formData.source_condition_line_id ?? formData.rsConditionLineId);
  const explicitOutboundId = positiveId(formData.source_out_condition_line_id);
  if (!inboundId && !explicitOutboundId) {
    return { formData, changed: false, message: "条件明細IDがないため製品名は再補完していません。" };
  }

  try {
    if (explicitOutboundId) {
      const preview = await loadPreview(explicitOutboundId, formData, fetcher);
      return preview
        ? refreshed(formData, preview)
        : { formData, changed: false, message: "OUT条件から製品名を再取得できませんでした。" };
    }

    const inboundPreview = await loadPreview(inboundId!, formData, fetcher);
    if (!inboundPreview) {
      return { formData, changed: false, message: "IN条件から製品名を再取得できませんでした。" };
    }
    if (inboundPreview.transactionModelName.includes("自社製造")) {
      return refreshed(formData, inboundPreview);
    }

    // 旧かんたん受領入力は OUT 条件IDを保存していなかったため、入金元＋親IN条件で一意に復元する。
    const payer = String(formData.payerCompany ?? "").trim();
    if (!payer) {
      return { formData, changed: false, message: "入金元がないため対応するOUT条件を特定できません。" };
    }
    const response = await fetcher(
      `/api/v2/license-settlements/conditions?q=${encodeURIComponent(payer)}&limit=300`
    );
    if (!response.ok) throw new Error("condition search failed");
    const body = await response.json() as { conditions?: ConditionCandidate[] };
    const candidates = (body.conditions ?? []).filter((condition) =>
      condition.direction === "receivable"
      && condition.parentLicenseConditionId === inboundId
      && String(condition.counterparty ?? "").trim() === payer
    );
    if (candidates.length !== 1) {
      return {
        formData,
        changed: false,
        message: candidates.length > 1
          ? "対応するOUT条件が複数あるため自動更新していません。OUT条件を選び直してください。"
          : "対応するOUT条件を特定できないため自動更新していません。OUT条件を選び直してください。"
      };
    }
    const preview = await loadPreview(candidates[0].id, formData, fetcher);
    return preview
      ? refreshed(formData, preview, candidates[0].id)
      : { formData, changed: false, message: "OUT条件から製品名を再取得できませんでした。" };
  } catch {
    return { formData, changed: false, message: "条件DBに接続できず、製品名は保存時の値を表示しています。" };
  }
}

async function loadPreview(
  conditionLineId: number,
  formData: DocumentFormData,
  fetcher: typeof fetch
): Promise<ProductPreview | null> {
  const occurredAt = String(formData.settlement_occurred_at ?? "").trim() || new Date().toISOString();
  const response = await fetcher("/api/v2/license-settlements/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conditionLineId, trigger: "sublicense_receipt", occurredAt })
  });
  if (!response.ok) return null;
  return (await response.json() as { preview?: ProductPreview }).preview ?? null;
}

function refreshed(
  formData: DocumentFormData,
  preview: ProductPreview,
  inferredOutboundId?: number
): RoyaltyEditRefreshResult {
  const regionLanguage = [preview.licenseTerritory, preview.licenseLanguage].filter(Boolean).join("／");
  const lines = Array.isArray(formData.lines)
    ? (formData.lines as Array<Record<string, unknown>>).map((line) => ({
        ...line,
        productName: preview.productName,
        region_language_label: regionLanguage
      }))
    : formData.lines;
  // 多明細計算書は preview 時に rs_receipts から lineGroups を再構築する。
  // ここを更新しないと top-level の製品名だけが新しくなり、PDF明細は
  // row.productName 不在時の fallback（サブライセンシー名）のままになる。
  const receipts = Array.isArray(formData.rs_receipts)
    ? (formData.rs_receipts as Array<Record<string, unknown>>).map((receipt) => ({
        ...receipt,
        productName: preview.productName
      }))
    : formData.rs_receipts;
  // 旧下書きに計算済み lineGroups だけが残る場合にも表示を揃える。
  const lineGroups = Array.isArray(formData.lineGroups)
    ? (formData.lineGroups as Array<Record<string, unknown>>).map((group) => ({
        ...group,
        lines: Array.isArray(group.lines)
          ? (group.lines as Array<Record<string, unknown>>).map((line) => ({
              ...line,
              productName: preview.productName,
              region_language_label: regionLanguage
            }))
          : group.lines
      }))
    : formData.lineGroups;
  return {
    formData: {
      ...formData,
      productName: preview.productName,
      transactionModelName: preview.transactionModelName,
      licenseTerritory: preview.licenseTerritory,
      licenseLanguage: preview.licenseLanguage,
      licenseScopeSource: preview.licenseScopeSource,
      region_language_label: regionLanguage,
      ...(lines ? { lines } : {}),
      ...(receipts ? { rs_receipts: receipts } : {}),
      ...(lineGroups ? { lineGroups } : {}),
      ...(inferredOutboundId ? { source_out_condition_line_id: inferredOutboundId } : {})
    },
    changed: true,
    message: `製品名を条件DBから再補完しました（${preview.licenseScopeSource === "out" ? "OUT" : "IN"}条件の地域・言語）。保存または再発行するまでは元文書は変更されません。`
  };
}
