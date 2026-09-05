import type { PoolClient } from "pg";
import type { DocumentFormData } from "../../types.js";

export interface RoyaltyNormalizationDocument {
  id: number;
  documentNumber: string;
  issueKey: string;
  contractId?: number | null;
  vendorId?: number | null;
  materialRefId?: number | null;
  createdAt: string;
}

type Json = Record<string, unknown>;

export async function persistRoyaltyNormalization(
  client: PoolClient,
  document: RoyaltyNormalizationDocument,
  formData: DocumentFormData
) {
  const source = formData as Json;
  const conditionLineId = await validConditionLineId(
    client,
    positiveInt(pick(source, "source_condition_line_id", "rsConditionLineId", "condition_line_id"))
  );
  const sourceOutConditionLineId = await validConditionLineId(
    client,
    positiveInt(pick(source, "source_out_condition_line_id"))
  );
  const contractId = await validContractId(
    client,
    positiveInt(pick(source, "source_contract_id", "license_contract_id", "contract_id"))
      ?? document.contractId
      ?? null
  );
  const eventType = normalizeTrigger(
    stringValue(pick(source, "settlement_trigger", "calcType", "rsCalcType"))
  );
  const occurredAt = dateTimeValue(
    pick(source, "settlement_occurred_at", "completionDate", "documentDate")
  ) ?? document.createdAt;
  const period = stringValue(pick(source, "period"))
    || occurredAt.slice(0, 7);
  const currency = stringValue(pick(source, "currency", "intakeCurrency")) || "JPY";
  const quantity = numberValue(pick(source, "quantity", "rsQuantity"));
  const sampleQuantity = numberValue(pick(source, "sampleQuantity", "rsSampleQuantity")) ?? 0;
  const billableQuantity = numberValue(pick(source, "billableQuantity"))
    ?? (quantity === null ? null : Math.max(0, quantity - sampleQuantity));
  const unitPrice = numberValue(pick(source, "unit_price", "MSRP", "rsMsrp"))
    ?? (eventType === "manufacturing" ? numberValue(pick(source, "msrpStr", "基準価格")) : null);
  const basisAmount = numberValue(pick(source, "settlement_basis_amount"))
    ?? numberValue(pick(source, "sales_amount", "salesInput"));
  const grossEventAmount = numberValue(pick(source, "settlement_gross_event_amount"));
  const deductions = numberValue(pick(source, "settlement_deductions")) ?? 0;
  const ratePct = numberValue(pick(source, "royaltyRatePct", "rsRatePct", "rsInRatePct", "料率"));
  const grossRoyalty = numberValue(pick(source, "grossRoyaltyStr"))
    ?? numberValue(pick(source, "gross_royalty_ex_tax"));
  const actualRoyalty = numberValue(pick(source, "actualRoyalty", "actualRoyaltyStr", "royalty_amount"))
    ?? grossRoyalty;
  const taxRate = numberValue(pick(source, "taxRate"));
  const taxAmount = numberValue(pick(source, "taxAmount"));
  const totalPayment = numberValue(pick(source, "totalPaymentStr"));
  const mgAmount = numberValue(pick(source, "mgAmount", "rsMgAmount"));
  const agAmount = numberValue(pick(source, "agAmount", "rsAgAmount"));
  const mgConsumedBefore = numberValue(pick(source, "mgConsumedBefore"));
  const mgConsumedThisTime = numberValue(pick(source, "mgConsumedThisTime"));
  const mgConsumedAfter = numberValue(pick(source, "mgConsumedAfter"));
  const mgRemaining = numberValue(pick(source, "mgRemaining"));
  const agConsumedBefore = numberValue(pick(source, "agConsumedBefore", "rsAgConsumedBefore"));
  const agConsumedThisTime = numberValue(pick(source, "agConsumedThisTime"));
  const agConsumedAfter = numberValue(pick(source, "agConsumedAfter"));
  const agRemaining = numberValue(pick(source, "agRemaining"));
  const reportingDeadline = dateValue(pick(source, "reportingDeadline"));
  const paymentDueDate = dateValue(pick(source, "paymentDueDate"));
  const notes = stringValue(pick(source, "notes", "remarks", "bridgeNotice"));
  const productName = stringValue(pick(source, "productName", "PROJECT_TITLE", "originalWork"))
    || "利用許諾対象";

  const sourceCondition = conditionLineId
    ? await conditionSource(client, conditionLineId)
    : null;
  const productId = sourceCondition?.productId ?? null;
  const workMaterialId = sourceCondition?.sourceMaterialId ?? document.materialRefId ?? null;

  const manufacturingEventId = eventType === "manufacturing"
    ? await upsertManufacturingEvent(client, {
        documentId: document.id,
        issueKey: document.issueKey,
        contractId,
        productId,
        productName,
        occurredAt,
        quantity,
        sampleQuantity,
        billableQuantity,
        unitPrice,
        totalPayment,
        edition: stringValue(pick(source, "edition"))
      })
    : null;

  const salesEventId = eventType === "sale"
    ? await upsertSalesEvent(client, {
        documentId: document.id,
        conditionLineId,
        productId,
        issueKey: document.issueKey,
        period,
        soldQuantity: billableQuantity ?? quantity,
        salesAmount: grossEventAmount ?? basisAmount,
        reportDate: occurredAt.slice(0, 10)
      })
    : null;

  if (eventType === "sublicense_receipt") {
    await upsertConditionReceipt(client, {
      documentId: document.id,
      conditionLineId: sourceOutConditionLineId ?? conditionLineId,
      parentConditionLineId: conditionLineId,
      period,
      periodDate: occurredAt.slice(0, 10),
      receivedAmount: grossEventAmount ?? basisAmount,
      receivedDate: occurredAt.slice(0, 10),
      distributionBase: basisAmount,
      distributionRatePct: ratePct,
      computedDistributionExTax: actualRoyalty,
      note: notes
    });
  }

  const calculationId = await upsertRoyaltyCalculation(client, {
    documentId: document.id,
    issueKey: document.issueKey,
    contractId,
    conditionLineId,
    sourceOutConditionLineId,
    manufacturingEventId,
    eventType,
    occurredAt,
    unitPrice,
    quantity,
    sampleQuantity,
    billableQuantity,
    basisAmount,
    deductions,
    ratePct,
    grossRoyalty,
    actualRoyalty,
    mgAmount,
    mgConsumedBefore,
    mgConsumedThisTime,
    mgConsumedAfter,
    mgRemaining,
    agAmount,
    agConsumedBefore,
    agConsumedThisTime,
    agConsumedAfter,
    agRemaining,
    taxRate,
    taxAmount,
    totalPayment,
    currency,
    period,
    reportingDeadline,
    paymentDueDate,
    notes,
    source
  });

  const conditionEventId = conditionLineId && actualRoyalty !== null
    ? await upsertConditionEvent(client, {
        conditionLineId,
        documentId: document.id,
        issueKey: document.issueKey,
        occurredAt,
        period,
        amountExTax: actualRoyalty,
        calculationId,
        manufacturingEventId,
        mgConsumedThisTime,
        agConsumedThisTime
      })
    : null;

  if (conditionEventId) {
    await client.query(
      `UPDATE royalty_calculations
          SET condition_event_id = $2, updated_at = now()
        WHERE id = $1`,
      [calculationId, conditionEventId]
    );
  }

  const statementId = await upsertRoyaltyStatement(client, {
    documentId: document.id,
    issueKey: document.issueKey,
    contractId,
    productId,
    workMaterialId,
    manufacturingEventId,
    salesEventId,
    conditionLineId,
    sourceOutConditionLineId,
    eventType,
    occurredAt,
    unitPrice,
    quantity,
    sampleQuantity,
    billableQuantity,
    basisAmount,
    deductions,
    ratePct,
    grossRoyalty,
    actualRoyalty,
    mgAmount,
    mgConsumedBefore,
    mgConsumedThisTime,
    mgConsumedAfter,
    mgRemaining,
    agAmount,
    agConsumedBefore,
    agConsumedThisTime,
    agConsumedAfter,
    agRemaining,
    taxRate,
    taxAmount,
    totalPayment,
    currency,
    period,
    reportingDeadline,
    paymentDueDate,
    notes,
    source
  });

  await replaceRoyaltyStatementLines(client, statementId, document, source, {
    contractId,
    contractTitle: stringValue(pick(source, "contractTitle", "CONTRACT_TITLE")),
    contractNumber: stringValue(pick(source, "linked_contract_number", "CONTRACT_NO")),
    calcMethod: eventType || stringValue(pick(source, "calcType", "rsCalcType")),
    productName,
    currency,
    fxRate: numberValue(pick(source, "fxRate")),
    basisAmount,
    unitPrice,
    quantity,
    sampleQuantity,
    ratePct,
    actualRoyalty,
    conditionLineId,
    sourceOutConditionLineId,
    grossEventAmount,
    deductions,
    notes
  });

  return { calculationId, conditionEventId, statementId };
}

async function upsertRoyaltyCalculation(client: PoolClient, value: any) {
  const result = await client.query(
    `INSERT INTO royalty_calculations (
       document_id, backlog_issue_key, license_contract_id, calc_type,
       unit_price, quantity, sample_quantity, billable_quantity, rate_pct,
       gross_royalty_ex_tax, mg_amount, mg_consumed_before, mg_consumed_this_time,
       mg_consumed_after, mg_remaining, mg_fully_consumed, actual_royalty_ex_tax,
       tax_rate, tax_amount, total_payment_inc_tax, currency, period,
       reporting_deadline, payment_due_date, notes, mg_topup_this_time,
       ag_amount, ag_consumed_before, ag_consumed_this_time, ag_consumed_after,
       ag_remaining, ag_fully_consumed, condition_line_id,
       source_out_condition_line_id, basis_amount, deductions,
       event_type, occurred_at, source_form_data, manufacturing_event_id,
       updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,0,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,
       $38::jsonb,$39,now()
     )
     ON CONFLICT (document_id) DO UPDATE SET
       backlog_issue_key=EXCLUDED.backlog_issue_key,
       license_contract_id=EXCLUDED.license_contract_id,
       calc_type=EXCLUDED.calc_type, unit_price=EXCLUDED.unit_price,
       quantity=EXCLUDED.quantity, sample_quantity=EXCLUDED.sample_quantity,
       billable_quantity=EXCLUDED.billable_quantity, rate_pct=EXCLUDED.rate_pct,
       gross_royalty_ex_tax=EXCLUDED.gross_royalty_ex_tax,
       mg_amount=EXCLUDED.mg_amount, mg_consumed_before=EXCLUDED.mg_consumed_before,
       mg_consumed_this_time=EXCLUDED.mg_consumed_this_time,
       mg_consumed_after=EXCLUDED.mg_consumed_after, mg_remaining=EXCLUDED.mg_remaining,
       mg_fully_consumed=EXCLUDED.mg_fully_consumed,
       actual_royalty_ex_tax=EXCLUDED.actual_royalty_ex_tax,
       tax_rate=EXCLUDED.tax_rate, tax_amount=EXCLUDED.tax_amount,
       total_payment_inc_tax=EXCLUDED.total_payment_inc_tax,
       currency=EXCLUDED.currency, period=EXCLUDED.period,
       reporting_deadline=EXCLUDED.reporting_deadline,
       payment_due_date=EXCLUDED.payment_due_date, notes=EXCLUDED.notes,
       ag_amount=EXCLUDED.ag_amount, ag_consumed_before=EXCLUDED.ag_consumed_before,
       ag_consumed_this_time=EXCLUDED.ag_consumed_this_time,
       ag_consumed_after=EXCLUDED.ag_consumed_after, ag_remaining=EXCLUDED.ag_remaining,
       ag_fully_consumed=EXCLUDED.ag_fully_consumed,
       condition_line_id=EXCLUDED.condition_line_id,
       source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
       basis_amount=EXCLUDED.basis_amount, deductions=EXCLUDED.deductions,
       event_type=EXCLUDED.event_type, occurred_at=EXCLUDED.occurred_at,
       source_form_data=EXCLUDED.source_form_data,
       manufacturing_event_id=EXCLUDED.manufacturing_event_id,
       updated_at=now()
     RETURNING id`,
    [
      value.documentId, value.issueKey, value.contractId, value.eventType,
      value.unitPrice, value.quantity, value.sampleQuantity, value.billableQuantity,
      value.ratePct, value.grossRoyalty, value.mgAmount, value.mgConsumedBefore,
      value.mgConsumedThisTime, value.mgConsumedAfter, value.mgRemaining,
      boolOrNull(value.mgRemaining, value.mgAmount), value.actualRoyalty,
      value.taxRate, value.taxAmount, value.totalPayment, value.currency, value.period,
      value.reportingDeadline, value.paymentDueDate, value.notes, value.agAmount,
      value.agConsumedBefore, value.agConsumedThisTime, value.agConsumedAfter,
      value.agRemaining, boolOrNull(value.agRemaining, value.agAmount),
      value.conditionLineId, value.sourceOutConditionLineId, value.basisAmount,
      value.deductions, value.eventType, value.occurredAt, JSON.stringify(value.source),
      value.manufacturingEventId
    ]
  );
  return Number(result.rows[0].id);
}

async function upsertRoyaltyStatement(client: PoolClient, value: any) {
  const result = await client.query(
    `INSERT INTO royalty_statements (
       document_id, backlog_issue_key, contract_id, product_id, work_material_id,
       manufacturing_event_id, sales_event_id, calc_type, unit_price, quantity,
       sample_quantity, billable_quantity, rate_pct, gross_royalty_ex_tax,
       mg_amount, mg_consumed_before, mg_consumed_this_time, mg_consumed_after,
       mg_remaining, mg_fully_consumed, mg_topup_this_time, ag_amount,
       ag_consumed_before, ag_consumed_this_time, ag_consumed_after, ag_remaining,
       ag_fully_consumed, actual_royalty_ex_tax, tax_rate, tax_amount,
       total_payment_inc_tax, currency, period, reporting_deadline, payment_due_date,
       notes, source_condition_line_id, source_out_condition_line_id,
       event_type, occurred_at, basis_amount, deductions, source_form_data, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,0,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
       $39,$40,$41,$42::jsonb,now()
     )
     ON CONFLICT (document_id) DO UPDATE SET
       backlog_issue_key=EXCLUDED.backlog_issue_key, contract_id=EXCLUDED.contract_id,
       product_id=EXCLUDED.product_id, work_material_id=EXCLUDED.work_material_id,
       manufacturing_event_id=EXCLUDED.manufacturing_event_id,
       sales_event_id=EXCLUDED.sales_event_id, calc_type=EXCLUDED.calc_type,
       unit_price=EXCLUDED.unit_price, quantity=EXCLUDED.quantity,
       sample_quantity=EXCLUDED.sample_quantity, billable_quantity=EXCLUDED.billable_quantity,
       rate_pct=EXCLUDED.rate_pct, gross_royalty_ex_tax=EXCLUDED.gross_royalty_ex_tax,
       mg_amount=EXCLUDED.mg_amount, mg_consumed_before=EXCLUDED.mg_consumed_before,
       mg_consumed_this_time=EXCLUDED.mg_consumed_this_time,
       mg_consumed_after=EXCLUDED.mg_consumed_after, mg_remaining=EXCLUDED.mg_remaining,
       mg_fully_consumed=EXCLUDED.mg_fully_consumed, ag_amount=EXCLUDED.ag_amount,
       ag_consumed_before=EXCLUDED.ag_consumed_before,
       ag_consumed_this_time=EXCLUDED.ag_consumed_this_time,
       ag_consumed_after=EXCLUDED.ag_consumed_after, ag_remaining=EXCLUDED.ag_remaining,
       ag_fully_consumed=EXCLUDED.ag_fully_consumed,
       actual_royalty_ex_tax=EXCLUDED.actual_royalty_ex_tax,
       tax_rate=EXCLUDED.tax_rate, tax_amount=EXCLUDED.tax_amount,
       total_payment_inc_tax=EXCLUDED.total_payment_inc_tax,
       currency=EXCLUDED.currency, period=EXCLUDED.period,
       reporting_deadline=EXCLUDED.reporting_deadline,
       payment_due_date=EXCLUDED.payment_due_date, notes=EXCLUDED.notes,
       source_condition_line_id=EXCLUDED.source_condition_line_id,
       source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
       event_type=EXCLUDED.event_type, occurred_at=EXCLUDED.occurred_at,
       basis_amount=EXCLUDED.basis_amount, deductions=EXCLUDED.deductions,
       source_form_data=EXCLUDED.source_form_data, updated_at=now()
     RETURNING id`,
    [
      value.documentId, value.issueKey, value.contractId, value.productId,
      value.workMaterialId, value.manufacturingEventId, value.salesEventId,
      value.eventType, value.unitPrice, value.quantity, value.sampleQuantity,
      value.billableQuantity, value.ratePct, value.grossRoyalty, value.mgAmount,
      value.mgConsumedBefore, value.mgConsumedThisTime, value.mgConsumedAfter,
      value.mgRemaining, boolOrNull(value.mgRemaining, value.mgAmount), value.agAmount,
      value.agConsumedBefore, value.agConsumedThisTime, value.agConsumedAfter,
      value.agRemaining, boolOrNull(value.agRemaining, value.agAmount),
      value.actualRoyalty, value.taxRate, value.taxAmount, value.totalPayment,
      value.currency, value.period, value.reportingDeadline, value.paymentDueDate,
      value.notes, value.conditionLineId, value.sourceOutConditionLineId,
      value.eventType, value.occurredAt, value.basisAmount, value.deductions,
      JSON.stringify(value.source)
    ]
  );
  return Number(result.rows[0].id);
}

async function replaceRoyaltyStatementLines(
  client: PoolClient,
  statementId: number,
  document: RoyaltyNormalizationDocument,
  source: Json,
  fallback: any
) {
  const rawLines = records(pick(source, "lines", "royalty_lines"));
  const lines = rawLines.length ? rawLines : [{
    productName: fallback.productName,
    sales_amount: fallback.basisAmount,
    rate_pct: fallback.ratePct,
    royalty_amount: fallback.actualRoyalty,
    basisNote: fallback.notes
  }];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineCurrency = stringValue(pick(line, "currency", "intake_currency")) || fallback.currency;
    const salesInput = numberValue(pick(line, "sales_input", "sales_amount", "base_amount"))
      ?? fallback.basisAmount;
    const linePayment = numberValue(pick(line, "payment_jpy", "payment_amount", "royalty_amount"))
      ?? fallback.actualRoyalty;
    await client.query(
      `INSERT INTO royalty_statement_lines (
         royalty_statement_id, document_id, document_number, backlog_issue_key,
         line_no, group_no, contract_id, contract_title, contract_number,
         calc_method, product_name, intake_currency, fx_rate, sales_input,
         unit_price, quantity, sample_quantity, sales_jpy, rate_pct, payment_jpy,
         basis_note, source_condition_line_id, source_out_condition_line_id,
         gross_event_amount, deductions, source_json
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26::jsonb
       )
       ON CONFLICT (royalty_statement_id, line_no) DO UPDATE SET
         document_id=EXCLUDED.document_id,
         document_number=EXCLUDED.document_number,
         backlog_issue_key=EXCLUDED.backlog_issue_key,
         group_no=EXCLUDED.group_no,
         contract_id=EXCLUDED.contract_id,
         contract_title=EXCLUDED.contract_title,
         contract_number=EXCLUDED.contract_number,
         calc_method=EXCLUDED.calc_method,
         product_name=EXCLUDED.product_name,
         intake_currency=EXCLUDED.intake_currency,
         fx_rate=EXCLUDED.fx_rate,
         sales_input=EXCLUDED.sales_input,
         unit_price=EXCLUDED.unit_price,
         quantity=EXCLUDED.quantity,
         sample_quantity=EXCLUDED.sample_quantity,
         sales_jpy=EXCLUDED.sales_jpy,
         rate_pct=EXCLUDED.rate_pct,
         payment_jpy=EXCLUDED.payment_jpy,
         basis_note=EXCLUDED.basis_note,
         source_condition_line_id=EXCLUDED.source_condition_line_id,
         source_out_condition_line_id=EXCLUDED.source_out_condition_line_id,
         gross_event_amount=EXCLUDED.gross_event_amount,
         deductions=EXCLUDED.deductions,
         source_json=EXCLUDED.source_json`,
      [
        statementId, document.id, document.documentNumber, document.issueKey, index + 1,
        numberValue(pick(line, "group_no")) ?? 1, fallback.contractId,
        stringValue(pick(line, "contractTitle")) || fallback.contractTitle,
        stringValue(pick(line, "contractNumber")) || fallback.contractNumber,
        stringValue(pick(line, "calc_method")) || fallback.calcMethod,
        stringValue(pick(line, "productName", "product_name")) || fallback.productName,
        lineCurrency, numberValue(pick(line, "fx_rate")) ?? fallback.fxRate,
        salesInput, numberValue(pick(line, "unit_price")) ?? fallback.unitPrice,
        numberValue(pick(line, "quantity")) ?? fallback.quantity,
        numberValue(pick(line, "sample_quantity")) ?? fallback.sampleQuantity,
        lineCurrency === "JPY" ? salesInput : numberValue(pick(line, "sales_jpy")),
        numberValue(pick(line, "rate_pct")) ?? fallback.ratePct,
        lineCurrency === "JPY" ? linePayment : numberValue(pick(line, "payment_jpy")),
        stringValue(pick(line, "basisNote", "basis_note")) || fallback.notes,
        fallback.conditionLineId, fallback.sourceOutConditionLineId,
        fallback.grossEventAmount, fallback.deductions, JSON.stringify(line)
      ]
    );
  }
}

async function upsertConditionEvent(client: PoolClient, value: any) {
  const existing = await client.query(
    `SELECT id FROM condition_events
      WHERE condition_line_id = $1 AND document_id = $2
        AND event_type = 'royalty_calc' AND voided_at IS NULL
      ORDER BY id LIMIT 1`,
    [value.conditionLineId, value.documentId]
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE condition_events
          SET occurred_at=$2, period=$3, amount_ex_tax=$4,
              backlog_issue_key=$5, source_royalty_calculation_id=$6,
              manufacturing_event_id=$7, mg_consumed_this_time=$8,
              ag_consumed_this_time=$9
        WHERE id=$1`,
      [
        existing.rows[0].id, value.occurredAt, value.period, value.amountExTax,
        value.issueKey, value.calculationId, value.manufacturingEventId,
        value.mgConsumedThisTime, value.agConsumedThisTime
      ]
    );
    return Number(existing.rows[0].id);
  }
  const next = await client.query(
    `SELECT COALESCE(MAX(event_no),0)+1 AS event_no
       FROM condition_events WHERE condition_line_id=$1 FOR UPDATE`,
    [value.conditionLineId]
  );
  const result = await client.query(
    `INSERT INTO condition_events (
       condition_line_id,event_no,event_type,document_id,backlog_issue_key,
       occurred_at,period,amount_ex_tax,source_royalty_calculation_id,
       manufacturing_event_id,mg_consumed_this_time,ag_consumed_this_time
     ) VALUES ($1,$2,'royalty_calc',$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      value.conditionLineId, Number(next.rows[0].event_no), value.documentId,
      value.issueKey, value.occurredAt, value.period, value.amountExTax,
      value.calculationId, value.manufacturingEventId,
      value.mgConsumedThisTime, value.agConsumedThisTime
    ]
  );
  return Number(result.rows[0].id);
}

async function upsertManufacturingEvent(client: PoolClient, value: any) {
  const result = await client.query(
    `INSERT INTO manufacturing_events (
       backlog_issue_key,license_contract_id,product_name,completion_date,
       quantity,msrp,total_payment,unit_price,sample_quantity,billable_quantity,
       edition,product_id,source_document_id,source_condition_line_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (backlog_issue_key) DO UPDATE SET
       license_contract_id=COALESCE(EXCLUDED.license_contract_id,manufacturing_events.license_contract_id),
       product_name=EXCLUDED.product_name,completion_date=EXCLUDED.completion_date,
       quantity=EXCLUDED.quantity,msrp=EXCLUDED.msrp,total_payment=EXCLUDED.total_payment,
       unit_price=EXCLUDED.unit_price,sample_quantity=EXCLUDED.sample_quantity,
       billable_quantity=EXCLUDED.billable_quantity,edition=EXCLUDED.edition,
       product_id=COALESCE(EXCLUDED.product_id,manufacturing_events.product_id),
       source_document_id=EXCLUDED.source_document_id,
       source_condition_line_id=EXCLUDED.source_condition_line_id
     RETURNING id`,
    [
      value.issueKey, value.contractId, value.productName, value.occurredAt.slice(0,10),
      value.quantity, value.unitPrice, value.totalPayment, value.sampleQuantity,
      value.billableQuantity, value.edition, value.productId, value.documentId,
      value.conditionLineId
    ]
  );
  return Number(result.rows[0].id);
}

async function upsertSalesEvent(client: PoolClient, value: any) {
  const existing = await client.query(
    "SELECT id FROM sales_events WHERE source_document_id=$1 LIMIT 1",
    [value.documentId]
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE sales_events SET product_id=$2,backlog_issue_key=$3,period=$4,
        sold_quantity=$5,sales_amount=$6,report_date=$7,source_condition_line_id=$8
        WHERE id=$1`,
      [existing.rows[0].id,value.productId,value.issueKey,value.period,value.soldQuantity,
       value.salesAmount,value.reportDate,value.conditionLineId]
    );
    return Number(existing.rows[0].id);
  }
  const result = await client.query(
    `INSERT INTO sales_events (
       product_id,backlog_issue_key,period,sold_quantity,sales_amount,report_date,
       source_document_id,source_condition_line_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      value.productId,value.issueKey,value.period,value.soldQuantity,value.salesAmount,
      value.reportDate,value.documentId,value.conditionLineId
    ]
  );
  return Number(result.rows[0].id);
}

async function upsertConditionReceipt(client: PoolClient, value: any) {
  const existing = await client.query(
    "SELECT id FROM condition_receipts WHERE source_document_id=$1 LIMIT 1",
    [value.documentId]
  );
  const args = [
    value.conditionLineId,value.period,value.periodDate,value.computedDistributionExTax,
    value.receivedAmount,value.receivedDate,value.note,value.parentConditionLineId,
    value.distributionBase,value.distributionRatePct,value.computedDistributionExTax,
    value.documentId
  ];
  if (existing.rows[0]) {
    await client.query(
      `UPDATE condition_receipts SET
        condition_line_id=$2,period=$3,period_date=$4,computed_royalty_ex_tax=$5,
        received_amount=$6,received_date=$7,status='received',note=$8,
        distribution_parent_condition_id=$9,distribution_base=$10,distribution_qty=1,
        distribution_rate_pct=$11,computed_distribution_ex_tax=$12,updated_at=now()
        WHERE id=$1`,
      [existing.rows[0].id,...args.slice(0,11)]
    );
    return;
  }
  await client.query(
    `INSERT INTO condition_receipts (
       condition_line_id,period,period_date,computed_royalty_ex_tax,received_amount,
       received_date,status,note,distribution_parent_condition_id,distribution_base,
       distribution_qty,distribution_rate_pct,computed_distribution_ex_tax,source_document_id
     ) VALUES ($1,$2,$3,$4,$5,$6,'received',$7,$8,$9,1,$10,$11,$12)`,
    args
  );
}

async function conditionSource(client: PoolClient, id: number) {
  const result = await client.query(
    "SELECT product_id, source_material_id FROM condition_lines WHERE id=$1",
    [id]
  );
  return result.rows[0] ? {
    productId: positiveInt(result.rows[0].product_id),
    sourceMaterialId: positiveInt(result.rows[0].source_material_id)
  } : null;
}

async function validConditionLineId(client: PoolClient, id: number | null) {
  if (!id) return null;
  const result = await client.query("SELECT id FROM condition_lines WHERE id=$1", [id]);
  return result.rows[0] ? id : null;
}
async function validContractId(client: PoolClient, id: number | null) {
  if (!id) return null;
  const result = await client.query("SELECT id FROM contracts WHERE id=$1", [id]);
  return result.rows[0] ? id : null;
}

function records(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.filter((item): item is Json => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}
function pick(source: Json, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}
function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .replace(/[¥€$,％%\s]/g, "")
    .replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
function positiveInt(value: unknown): number | null {
  const n = numberValue(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}
function stringValue(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}
function dateValue(value: unknown) {
  const text = stringValue(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}
function dateTimeValue(value: unknown) {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function normalizeTrigger(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("manufact") || normalized.includes("製造")) return "manufacturing";
  if (normalized.includes("sale") || normalized.includes("売上") || normalized.includes("販売")) return "sale";
  if (normalized.includes("sublicense") || normalized.includes("receipt") || normalized.includes("入金")) {
    return "sublicense_receipt";
  }
  return normalized || "royalty";
}
function boolOrNull(remaining: number | null, amount: number | null) {
  if (remaining === null || amount === null) return null;
  return remaining <= 0;
}
