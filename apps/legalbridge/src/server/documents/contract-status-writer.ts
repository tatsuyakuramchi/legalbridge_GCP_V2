import type { DatabasePool } from "../db/pool.js";

// 契約状態の遷移（documents.contract_status・列レベル UPDATE・grant 031 を共用）。
// CloudSign 締結 Webhook（9-5）で契約を executed へ。権限未付与(42501)は forbidden で返し
// Webhook 全体は落とさない（受信自体は成功扱い）。

export interface ContractStatusResult { updated: number; forbidden: boolean }

export interface ContractStatusWriter {
  markExecuted(documentId: number): Promise<ContractStatusResult>;
}

export class PgContractStatusWriter implements ContractStatusWriter {
  constructor(private readonly database: DatabasePool) {}
  async markExecuted(documentId: number): Promise<ContractStatusResult> {
    try {
      const r = await this.database.query(
        `UPDATE documents SET contract_status = 'executed', updated_at = now()
          WHERE id = $1
            AND contract_status IN ('draft', 'awaiting_signature')`,
        [documentId]
      );
      return { updated: r.rowCount ?? 0, forbidden: false };
    } catch (error) {
      if ((error as { code?: string })?.code === "42501") return { updated: 0, forbidden: true };
      throw error;
    }
  }
}

export class MemoryContractStatusWriter implements ContractStatusWriter {
  readonly executed: number[] = [];
  constructor(private readonly forbidden = false) {}
  async markExecuted(documentId: number): Promise<ContractStatusResult> {
    if (this.forbidden) return { updated: 0, forbidden: true };
    this.executed.push(documentId);
    return { updated: 1, forbidden: false };
  }
}
