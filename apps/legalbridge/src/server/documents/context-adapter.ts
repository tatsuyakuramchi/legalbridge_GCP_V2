import { isIndividualEntity, resolveHonorific } from "../../honorific.js";
import { buildRenderContext } from "./rendering.js";

export { resolveHonorific };

type FormData = Record<string, unknown>;

export const COMMON_GENERATED_VARIABLES = new Set([
  "CONTRACT_NO", "DOC_NO", "ORDER_NO", "SIGN_DATE",
  "STAFF_NAME", "STAFF_DEPARTMENT", "STAFF_EMAIL", "STAFF_PHONE",
  "BASE_DOC_NO", "REVISION", "isReissue", "showReissueBanner",
  "VENDOR_IS_CORPORATION", "VENDOR_SUFFIX", "LICENSOR_SUFFIX"
]);

export function buildCommonDocumentContext(formData: FormData) {
  const details = isRecord(formData.details) ? formData.details : {};
  const source = { ...details, ...formData };
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return "";
  };
  const revision = pick("REVISION", "改訂番号", "revision", "revisionNumber");
  const baseDocumentNumber = pick(
    "BASE_DOC_NO", "元契約番号", "元文書番号",
    "baseDocumentNumber", "originalDocumentNumber"
  );
  const documentNumber = pick(
    "documentNumber", "文書番号", "契約書番号", "発注番号",
    "CONTRACT_NO", "DOC_NO", "ORDER_NO"
  );
  const revisionNumber = Number.parseInt(String(revision || "0"), 10) || 0;
  const isReissue = toBoolean(pick("isReissue", "再発行フラグ")) ||
    Boolean(baseDocumentNumber) || revisionNumber > 0;

  // 敬称は区分から導出する。テンプレートは敬称が空だと「御中」を既定にするため、
  // 区分だけ個人にしても敬称欄が空なら法人宛の「御中」で出てしまっていた。
  const vendorEntityType = pick("VENDOR_IS_CORPORATION", "取引先種別", "vendorEntityType");
  const licensorEntityType = pick("LICENSOR_IS_CORPORATION", "許諾者種別", "licensorEntityType");
  const vendorIndividual = isIndividualEntity(vendorEntityType);

  return {
    ...buildRenderContext({ ...details, ...formData }),
    CONTRACT_NO: pick("CONTRACT_NO", "契約書番号", "contractNumber") || documentNumber,
    DOC_NO: pick("DOC_NO", "文書番号") || documentNumber,
    ORDER_NO: pick("ORDER_NO", "発注番号") || documentNumber,
    SIGN_DATE: pick("SIGN_DATE", "契約締結日", "CONTRACT_DATE", "発行日", "date"),
    STAFF_NAME: pick("STAFF_NAME", "担当者名", "申請者名", "requester"),
    STAFF_DEPARTMENT: pick("STAFF_DEPARTMENT", "担当者部署", "申請部署"),
    STAFF_EMAIL: pick("STAFF_EMAIL", "担当者メール", "申請者メール"),
    STAFF_PHONE: pick("STAFF_PHONE", "担当者電話"),
    BASE_DOC_NO: baseDocumentNumber,
    REVISION: revisionNumber || "",
    isReissue,
    showReissueBanner:
      source.showReissueBanner === undefined ? isReissue : toBoolean(source.showReissueBanner),
    // テンプレートは `eq VENDOR_IS_CORPORATION "法人"`（発注書）と
    // `or VENDOR_IS_CORPORATION VENDOR_REP`（契約マスタ）の両方で使う。boolean を
    // 渡していたため前者が常に偽になり、法人でも「会社名（受注者）」欄が出なかった。
    // 法人は "法人"、個人は空文字にすると、文字列比較にも真偽判定にも正しく働く。
    VENDOR_IS_CORPORATION: vendorIndividual ? "" : "法人",
    VENDOR_SUFFIX: resolveHonorific(vendorEntityType, pick("VENDOR_SUFFIX", "取引先敬称")),
    LICENSOR_SUFFIX: resolveHonorific(licensorEntityType, pick("LICENSOR_SUFFIX", "許諾者敬称"))
  };
}

function isRecord(value: unknown): value is FormData {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on", "該当", "法人"]
    .includes(String(value).trim().toLowerCase());
}
