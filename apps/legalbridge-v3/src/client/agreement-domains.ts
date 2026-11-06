import type { AgreementDomain } from "../server/agreements/service.js";

/**
 * 契約の種別（番号の頭が決まる）。サーバの agreements/service.ts と同じ並び。
 * 売買・その他（覚書など）は infra/v3/200_agreement_domains.sql を流してから使える。
 */
export const DOMAIN_OPTIONS: Array<[AgreementDomain, string]> = [
  ["service", "業務委託"], ["license", "ライセンス"], ["sale", "売買"], ["other", "その他（覚書など）"]
];
export const DOMAIN_LABEL = Object.fromEntries(DOMAIN_OPTIONS) as Record<AgreementDomain, string>;

/** 基本契約・単体契約の番号の頭（サーバの numberPrefix と同じ）。 */
export const MASTER_PREFIX: Record<AgreementDomain, string> = { service: "ARC-SVC", license: "ARC-LIC", sale: "ARC-SAL", other: "ARC-OTH" };
export const STANDALONE_PREFIX: Record<AgreementDomain, string> = { service: "ARC-ISA", license: "ARC-ILT", sale: "ARC-ISL", other: "ARC-IOT" };
