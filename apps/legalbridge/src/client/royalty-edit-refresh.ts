import type { DocumentFormData } from "../types";
import { usesInboundLicenseScope } from "../license-scope";

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

/**
 * 相手先名のゆるい一致。「Maldito Games」と「Maldito Games SLU」、全角/半角スペース、大文字小文字、
 * 株式会社の有無程度のゆれを許す（正規化して片方がもう片方を含む）。
 */
export function looseNameMatch(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => String(v ?? "")
    .toLowerCase()
    .replace(/株式会社|有限会社|合同会社|\(株\)|（株）|co\.,?\s*ltd\.?|inc\.?|llc|ltd\.?|limited|s\.?l\.?u\.?|gmbh|s\.?a\.?/g, "")
    .replace(/[\s　,.、。・'"()（）\-_/]/g, "");
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

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
    const receipts = Array.isArray(formData.rs_receipts)
      ? formData.rs_receipts as Array<Record<string, unknown>>
      : [];

    // 複数サブライセンシーを含む計算書は、文書全体のOUT条件IDを全行へ流用できない。
    // 各受領行に保存したOUT条件ID、または相手先＋親IN条件で行ごとに復元する。
    if (inboundId && receipts.length > 0) {
      const inboundPreview = await loadPreview(inboundId, formData, fetcher);
      if (!inboundPreview) {
        return { formData, changed: false, message: "IN条件から製品名を再取得できませんでした。" };
      }
      if (usesInboundLicenseScope(inboundPreview.transactionModelName)) {
        return refreshed(formData, inboundPreview);
      }
      return await refreshReceiptProducts(
        formData, receipts, inboundId, explicitOutboundId, fetcher
      );
    }

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
    if (usesInboundLicenseScope(inboundPreview.transactionModelName)) {
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
      && looseNameMatch(condition.counterparty, payer)
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
  fetcher: typeof fetch,
  occurredAtOverride?: unknown
): Promise<ProductPreview | null> {
  const occurredAt = String(occurredAtOverride ?? formData.settlement_occurred_at ?? "").trim()
    || new Date().toISOString();
  const response = await fetcher("/api/v2/license-settlements/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conditionLineId, trigger: "sublicense_receipt", occurredAt })
  });
  if (!response.ok) return null;
  return (await response.json() as { preview?: ProductPreview }).preview ?? null;
}

async function refreshReceiptProducts(
  formData: DocumentFormData,
  receipts: Array<Record<string, unknown>>,
  inboundId: number,
  documentOutboundId: number | null,
  fetcher: typeof fetch
): Promise<RoyaltyEditRefreshResult> {
  const uniquePayers = new Set(receipts.map((row) => String(row.sublicensee ?? "").trim()).filter(Boolean));
  const previewById = new Map<number, ProductPreview | null>();
  const outboundByPayer = new Map<string, number | null>();
  const unresolved = new Set<string>();

  const previewFor = async (id: number, row: Record<string, unknown>) => {
    if (!previewById.has(id)) {
      previewById.set(id, await loadPreview(id, formData, fetcher, row.receivedOn));
    }
    return previewById.get(id) ?? null;
  };
  const outboundFor = async (payer: string) => {
    if (outboundByPayer.has(payer)) return outboundByPayer.get(payer) ?? null;
    const response = await fetcher(
      `/api/v2/license-settlements/conditions?q=${encodeURIComponent(payer)}&limit=300`
    );
    if (!response.ok) throw new Error("condition search failed");
    const body = await response.json() as { conditions?: ConditionCandidate[] };
    const candidates = (body.conditions ?? []).filter((condition) =>
      condition.direction === "receivable"
      && condition.parentLicenseConditionId === inboundId
      && looseNameMatch(condition.counterparty, payer)
    );
    const id = candidates.length === 1 ? candidates[0].id : null;
    outboundByPayer.set(payer, id);
    return id;
  };

  const refreshedReceipts: Array<Record<string, unknown>> = [];
  const previewByPayer = new Map<string, ProductPreview>();
  for (const row of receipts) {
    const payer = String(row.sublicensee ?? "").trim();
    let outboundId = positiveId(row.source_out_condition_line_id);
    // 旧単一相手先文書だけは、文書全体に保存されたOUT条件IDを引き継げる。
    if (!outboundId && uniquePayers.size === 1) outboundId = documentOutboundId;
    if (!outboundId && payer) outboundId = await outboundFor(payer);
    const preview = outboundId ? await previewFor(outboundId, row) : null;
    if (!preview) {
      if (payer) unresolved.add(payer);
      refreshedReceipts.push(row);
      continue;
    }
    previewByPayer.set(payer, preview);
    refreshedReceipts.push({
      ...row,
      productName: preview.productName,
      source_out_condition_line_id: outboundId,
      transactionModelName: preview.transactionModelName,
      licenseTerritory: preview.licenseTerritory,
      licenseLanguage: preview.licenseLanguage,
      licenseScopeSource: preview.licenseScopeSource,
      region_language_label: [preview.licenseTerritory, preview.licenseLanguage].filter(Boolean).join("／")
    });
  }

  if (previewByPayer.size === 0) {
    return {
      formData, changed: false,
      message: "受領明細に対応するOUT条件を特定できません。各明細のOUT条件を選び直してください。"
    };
  }
  const firstPreview = previewByPayer.values().next().value as ProductPreview;
  const lines = Array.isArray(formData.lines)
    ? (formData.lines as Array<Record<string, unknown>>).map((line, index) => {
        const receipt = refreshedReceipts[index];
        return receipt?.productName ? {
          ...line,
          productName: receipt.productName,
          region_language_label: receipt.region_language_label
        } : line;
      })
    : formData.lines;
  let lineIndex = 0;
  const lineGroups = Array.isArray(formData.lineGroups)
    ? (formData.lineGroups as Array<Record<string, unknown>>).map((group) => ({
        ...group,
        lines: Array.isArray(group.lines)
          ? (group.lines as Array<Record<string, unknown>>).map((line) => {
              const receipt = refreshedReceipts[lineIndex++];
              return receipt?.productName ? {
                ...line,
                productName: receipt.productName,
                region_language_label: receipt.region_language_label
              } : line;
            })
          : group.lines
      }))
    : formData.lineGroups;
  return {
    formData: {
      ...formData,
      productName: firstPreview.productName,
      transactionModelName: firstPreview.transactionModelName,
      licenseTerritory: firstPreview.licenseTerritory,
      licenseLanguage: firstPreview.licenseLanguage,
      licenseScopeSource: firstPreview.licenseScopeSource,
      region_language_label: [firstPreview.licenseTerritory, firstPreview.licenseLanguage].filter(Boolean).join("／"),
      rs_receipts: refreshedReceipts,
      ...(lines ? { lines } : {}),
      ...(lineGroups ? { lineGroups } : {})
    },
    changed: true,
    message: unresolved.size
      ? `製品名を${previewByPayer.size}社分再補完しました。未特定: ${[...unresolved].join("、")}`
      : `受領明細${receipts.length}行の製品名を、対応するOUT条件から再補完しました。保存または再発行するまでは元文書は変更されません。`
  };
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
