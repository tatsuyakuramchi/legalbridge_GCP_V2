import express, { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { dateStr, inTransaction, type Transactable } from "./core/db.js";
import { DomainError, statusFor } from "./core/errors.js";
import { requireRole, requireWritable } from "./auth.js";
import { ConditionRepository } from "./conditions/repository.js";
import { ConditionWriteService } from "./conditions/write-service.js";
import { ConditionEventService, EVENT_TYPES } from "./conditions/event-service.js";
import { ConditionScheduleService, TRIGGER_KINDS, EVENT_TYPE_BY_TRIGGER,
         generateLines } from "./conditions/schedule-service.js";
import { MatterWriteService } from "./matters/write-service.js";
import { MatterLinkService, CONDITION_KINDS_BY_MATTER } from "./matters/link-service.js";
import { LinkService } from "./links/service.js";
import { RELATIONS, type EntityKind } from "./links/relations.js";
import { DOCUMENT_STYLES } from "./matters/flow.js";
import { isStatementTemplate } from "./documents/template-context.js";
import { WorkWriteService } from "./works/write-service.js";
import { PartyWriteService } from "./parties/write-service.js";
import { PartyMergeService } from "./parties/merge-service.js";
import { MatterRepository } from "./matters/repository.js";
import { WorkRepository } from "./works/repository.js";
import { checkAgainstEnvelope } from "./works/envelope.js";
import { DocumentRepository } from "./documents/repository.js";
import { DocumentIssueService } from "./documents/issue-service.js";
import { DocumentSendService } from "./documents/send-service.js";
import { DocumentBatchService, templateCsv } from "./documents/batch-service.js";
import { ChromiumPdfRenderer, MemoryPdfRenderer, type PdfRenderer } from "./documents/pdf-renderer.js";
import { DocumentStorageService } from "./documents/storage-service.js";
import { GoogleDriveStorage, MemoryDriveStorage, type DriveStorage } from "./documents/drive-storage.js";
import { LocalFileStorage } from "./documents/local-file-storage.js";
import { DocumentImportService } from "./documents/import-service.js";
import { GoogleMatterDriveFolderService, LocalMatterDriveFolderService } from "./documents/drive-folder.js";
import { MatterFolderStorageService } from "./matters/drive-folder-service.js";
import { MatterCommunicationService, driveIdFromUrl, recordCommunication } from "./matters/communication-service.js";
import { config } from "./config.js";
import { verifySlackSignature } from "./integrations/signature.js";
import { RoyaltyStatementService } from "./royalty/statement-service.js";
import { bundleLineFrom, bundleTotals } from "./royalty/bundle.js";
import { PaymentService } from "./payments/service.js";
import { PaymentAllocationService } from "./payments/allocation-service.js";
import { PartyRepository } from "./parties/repository.js";
import { OpsRepository } from "./ops/repository.js";
import { SearchRepository } from "./search/repository.js";
import { ExportRepository, DATASETS, type Dataset } from "./exports/repository.js";
import { filename, withBom } from "./exports/csv.js";
import { AccountingExportLedger, AccountingExportRepository } from "./exports/accounting-repository.js";
import { ACCOUNTING_COLUMNS, BREAKDOWN_COLUMNS, totalRow } from "./exports/accounting.js";
import { XLS_MIME, toXls, withXlsBom, xlsFilename } from "./exports/xls.js";
import { PaymentReportRepository } from "./exports/payment-report.js";
import { ImportService, IMPORT_SPECS, type ImportKind } from "./imports/service.js";
import { MonitoringRepository } from "./monitoring/repository.js";
import { ReceivableRepository } from "./monitoring/receivables.js";
import { ContractCheckRepository } from "./monitoring/contract-check.js";
import { DailyJob } from "./jobs/daily.js";
import { IntakeService } from "./integrations/intake-service.js";
import {
  INTAKE_COMMANDS, buildIntakeModal, parseSubmission
} from "./integrations/slack-intake.js";
import { buildAdapters, buildDispatch, buildMailSource } from "./integrations/factory.js";
import { MailIntakeJob } from "./jobs/mail-intake.js";
import { BacklogService } from "./integrations/backlog-service.js";
import type { IntegrationChannel } from "./integrations/gate.js";
import { parseCompanyProfile } from "./ops/company-profile-schema.js";

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };

export function createRoutes(database: Transactable) {
  const router = Router();
  const conditions = new ConditionRepository(database);
  const conditionWrites = new ConditionWriteService(database);
  const conditionEvents = new ConditionEventService(database);
  const conditionSchedules = new ConditionScheduleService(database);
  const matters = new MatterRepository(database);
  const works = new WorkRepository(database);
  const documents = new DocumentRepository(database);
  const issues = new DocumentIssueService(database);
  const pdf: PdfRenderer = process.env.PDF_RENDERER === "memory"
    ? new MemoryPdfRenderer() : new ChromiumPdfRenderer();

  // Drive は未設定でも起動する。保存を呼んだときだけ 503 で理由を返す。
  const drive: DriveStorage | null =
    process.env.DRIVE_STORAGE === "memory" ? new MemoryDriveStorage()
    : process.env.DRIVE_STORAGE === "local" ? new LocalFileStorage(process.env.LOCAL_FILES_DIR || "./data/files")
    : config.driveFolderId
      ? new GoogleDriveStorage(config.driveFolderId, {
          keyFilePath: config.driveKeyFilePath || undefined,
          environmentTag: config.driveEnvironmentTag
        })
      : null;
  const storage = new DocumentStorageService(database, drive, pdf);
  const documentImports = new DocumentImportService(database, drive);
  const royalty = new RoyaltyStatementService(database);
  const payments = new PaymentService(database);
  const allocations = new PaymentAllocationService(database);
  const parties = new PartyRepository(database);
  const matterWrites = new MatterWriteService(database);
  const matterLinks = new MatterLinkService(database);
  const links = new LinkService(database);
  const workWrites = new WorkWriteService(database);
  const partyWrites = new PartyWriteService(database);
  const partyMerge = new PartyMergeService(database);
  const receivables = new ReceivableRepository(database);
  const contractCheck = new ContractCheckRepository(database);
  const search = new SearchRepository(database);
  const exports = new ExportRepository(database);
  const paymentReport = new PaymentReportRepository(database);
  const accounting = new AccountingExportRepository(database);
  const accountingLedger = new AccountingExportLedger(database);
  const imports = new ImportService(database);
  const ops = new OpsRepository(database);
  const monitoring = new MonitoringRepository(database);

  // 外部連携は factory で組む。/internal 側と同じものを使う。
  const adapters = buildAdapters();
  const dispatch = buildDispatch(database, adapters);
  const communications = new MatterCommunicationService(database, dispatch);
  const sends = new DocumentSendService(database);
  const batches = new DocumentBatchService(database, issues, communications, pdf);
  const mailSource = buildMailSource();
  const dailyJob = new DailyJob(database, dispatch);
  const mailJob = new MailIntakeJob(database, mailSource);
  const backlog = new BacklogService(database, dispatch, {
    host: config.backlogHost, issueTypeId: config.backlogIssueTypeId
  });
  const matterFolders = new MatterFolderStorageService(
    database,
    config.driveMatterParentFolderId
      ? new GoogleMatterDriveFolderService({ keyFilePath: config.driveKeyFilePath || undefined })
      : new LocalMatterDriveFolderService(),
    config.driveMatterParentFolderId
  );
  const actor = (res: Response) => res.locals.currentUser?.email ?? "unknown";

  // ---- 案件（制御レイヤー） ----
  // ---- 関連（画面と画面をつなぐハブ）----
  //
  // どの画面からでも同じ関連を読み書きできるようにする。案件から条件を
  // 繋げるのに条件から案件を繋げない、という片側だけの穴を塞ぐための1本。
  const ENTITY_KINDS = Object.keys(RELATIONS) as EntityKind[];
  const entityKind = (value: string): EntityKind => {
    if (!ENTITY_KINDS.includes(value as EntityKind)) {
      throw new DomainError("NOT_FOUND", `${value} という種類はありません`);
    }
    return value as EntityKind;
  };

  router.get("/links/:kind/:id", asyncRoute(async (req, res) => {
    res.json({ relations: await links.view(entityKind(String(req.params.kind)), Number(req.params.id)) });
  }));

  router.get("/links/:kind/:id/:relation/candidates", asyncRoute(async (req, res) => {
    res.json({ candidates: await links.candidates(
      entityKind(String(req.params.kind)), Number(req.params.id), String(req.params.relation),
      String(req.query.q ?? "")) });
  }));

  const attachLinkSchema = z.object({ targetId: z.coerce.number().int().positive() });
  router.post("/links/:kind/:id/:relation",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { targetId } = attachLinkSchema.parse(req.body ?? {});
      res.json(await links.attach(entityKind(String(req.params.kind)), Number(req.params.id),
        String(req.params.relation), targetId, actor(res)));
    }));

  router.delete("/links/:kind/:id/:relation/:targetId",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await links.detach(entityKind(String(req.params.kind)), Number(req.params.id),
        String(req.params.relation), Number(req.params.targetId), actor(res)));
    }));

  // ---- 契約（合意）----
  //
  // 条件は契約の明細であって、それ自体が契約書ではない。器である契約に
  // 画面が無かったので、条件が独立した書類のように見えていた。
  router.get("/agreements", asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const r = await database.query(
      `SELECT a.id, a.agreement_no, a.title, a.direction, a.status,
              a.executed_on, a.effective_on, a.expires_on,
              p.id AS party_id, p.name AS party_name,
              (SELECT count(*) FROM conditions c WHERE c.agreement_id = a.id)::int AS condition_count,
              (SELECT count(*) FROM documents d WHERE d.agreement_id = a.id)::int AS document_count,
              (SELECT COALESCE(sum(c.flat_amount), 0) FROM conditions c
                WHERE c.agreement_id = a.id AND c.status = 'active')::bigint AS total_flat
         FROM agreements a JOIN parties p ON p.id = a.counterparty_id
        WHERE ($1 = '' OR a.title ILIKE $1 OR COALESCE(a.agreement_no,'') ILIKE $1
               OR p.name ILIKE $1)
        ORDER BY a.id DESC LIMIT 200`, [q ? `%${q}%` : ""]);
    res.json({ agreements: (r.rows as Array<Record<string, any>>).map(mapAgreement) });
  }));

  router.get("/agreements/:id", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const head = await database.query(
      `SELECT a.id, a.agreement_no, a.title, a.direction, a.status,
              a.executed_on, a.effective_on, a.expires_on, a.auto_renewal,
              a.renewal_notice_months, a.source_url,
              p.id AS party_id, p.name AS party_name,
              0 AS condition_count, 0 AS document_count, 0 AS total_flat
         FROM agreements a JOIN parties p ON p.id = a.counterparty_id
        WHERE a.id = $1`, [id]);
    const row = head.rows[0] as Record<string, any> | undefined;
    if (!row) return res.status(404).json({ error: "契約が見つかりません" });
    // 明細（条件）はこの契約の中身。まとめて出す。
    const lines = await database.query(
      `SELECT c.id, c.condition_no, c.name, c.kind, c.status, c.direction, c.currency,
              c.pricing_model, c.rate_ppm, c.flat_amount, c.mg_amount, c.ag_amount,
              c.term_start, c.term_end, c.effective_from
         FROM conditions c WHERE c.agreement_id = $1
        ORDER BY c.id`, [id]);
    res.json({
      agreement: {
        ...mapAgreement(row),
        autoRenewal: row.auto_renewal === true,
        renewalNoticeMonths: row.renewal_notice_months ?? null,
        sourceUrl: row.source_url ?? null
      },
      conditions: (lines.rows as Array<Record<string, any>>).map((c) => ({
        id: Number(c.id), conditionNo: c.condition_no ?? null, name: String(c.name),
        kind: String(c.kind), status: String(c.status), direction: String(c.direction),
        currency: String(c.currency), pricingModel: String(c.pricing_model),
        ratePct: c.rate_ppm === null ? null : Number(c.rate_ppm) / 10000,
        flatAmount: c.flat_amount === null ? null : Number(c.flat_amount),
        mgAmount: c.mg_amount === null ? null : Number(c.mg_amount),
        agAmount: c.ag_amount === null ? null : Number(c.ag_amount),
        termStart: c.term_start ? String(c.term_start).slice(0, 10) : null,
        termEnd: c.term_end ? String(c.term_end).slice(0, 10) : null,
        effectiveFrom: c.effective_from ? String(c.effective_from).slice(0, 10) : null
      }))
    });
  }));

  router.get("/matters", asyncRoute(async (req, res) => {
    const kind = req.query.kind as "work" | "outsourcing" | "single" | undefined;
    res.json({ matters: await matters.list({
      keyword: String(req.query.q ?? ""),
      kind: kind && ["work", "outsourcing", "single"].includes(kind) ? kind : undefined,
      openOnly: req.query.open === "1"
    }) });
  }));

  router.get("/matters/:id", asyncRoute(async (req, res) => {
    const matter = await matters.find(Number(req.params.id));
    if (!matter) return res.status(404).json({ error: "案件が見つかりません" });
    res.json(matter);
  }));

  router.post("/matters/:id/drive-folder",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await matterFolders.ensure(Number(req.params.id), actor(res)));
    }));

  // 案件から Backlog の課題を立てる。受信側が案件を特定するための
  // 紐づけ（matter_links）はここでしか作られない。
  const backlogSchema = z.object({ note: z.string().trim().max(2000).optional() });
  router.post("/matters/:id/backlog",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { note } = backlogSchema.parse(req.body ?? {});
      res.json(await backlog.createIssue(Number(req.params.id), actor(res), { note }));
    }));

  // Backlog で先に立っている課題を案件に繋ぐ。移行前から Backlog で
  // 進めている案件は、こちらから立てる余地がない。
  const backlogLinkSchema = z.object({ issueKey: z.string().trim().min(3).max(60) });
  router.post("/matters/:id/backlog/link",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { issueKey } = backlogLinkSchema.parse(req.body ?? {});
      res.json(await backlog.link(Number(req.params.id), issueKey, actor(res)));
    }));

  // 間違った課題に繋いだときの直し方。課題そのものは消さない。
  router.delete("/matters/:id/backlog/:issueKey",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await backlog.unlink(
        Number(req.params.id), String(req.params.issueKey), actor(res)));
    }));

  // 案件の進み具合。段階は保存せず、揃っているものから導く。
  router.get("/matters/:id/flow", asyncRoute(async (req, res) => {
    res.json(await matterLinks.flow(Number(req.params.id)));
  }));

  // 案件に条件・文書を繋ぐ。読む処理はあったが書く処理が無く、
  // 案件の条件タブは常に空だった。
  const attachSchema = z.object({ conditionId: z.number().int().positive() });
  router.post("/matters/:id/conditions",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { conditionId } = attachSchema.parse(req.body ?? {});
      res.json(await matterLinks.attachCondition(Number(req.params.id), conditionId, actor(res)));
    }));

  router.delete("/matters/:id/conditions/:conditionId",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await matterLinks.detachCondition(
        Number(req.params.id), Number(req.params.conditionId), actor(res)));
    }));

  /**
   * 条件の側から案件に付ける。案件が無ければその場で作る。
   *
   * 繋ぐ操作が案件の画面にしか無かったので、条件を作った直後に付けられず、
   * 付いていない条件が溜まっていた。参照の向きは変えない（案件→条件）。
   */
  const conditionMatterSchema = z.object({
    matterId: z.coerce.number().int().positive().nullable().optional(),
    title: z.string().trim().max(200).optional(),
    // この条件から出した文書のうち、まだ案件が無いものも一緒に寄せる。
    withDocuments: z.boolean().default(true)
  });
  router.post("/conditions/:id/matters",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = conditionMatterSchema.parse(req.body ?? {});
      res.status(201).json(await matterLinks.linkFromCondition(
        Number(req.params.id), input, actor(res)));
    }));

  router.delete("/conditions/:id/matters/:matterId",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await matterLinks.detachCondition(
        Number(req.params.matterId), Number(req.params.id), actor(res)));
    }));

  const attachDocSchema = z.object({ documentId: z.number().int().positive() });
  router.post("/matters/:id/documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { documentId } = attachDocSchema.parse(req.body ?? {});
      res.json(await matterLinks.attachDocument(Number(req.params.id), documentId, actor(res)));
    }));

  router.delete("/matters/:id/documents/:documentId",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await matterLinks.detachDocument(
        Number(req.params.id), Number(req.params.documentId), actor(res)));
    }));

  // 取引モデルごとに使える条件の種類と、進め方の選択肢。
  // 取引モデルが「何を扱うか」、進め方が「どうやって文書を作るか」を決める。
  router.get("/matter-kinds", (_req, res) => {
    res.json({ kinds: CONDITION_KINDS_BY_MATTER, documentStyles: DOCUMENT_STYLES });
  });

  router.get("/matters/:id/drive-files", asyncRoute(async (req, res) => {
    res.json({ files: await matterFolders.listFiles(Number(req.params.id)) });
  }));

  // ---- 条件 ----
  router.get("/conditions", asyncRoute(async (req, res) => {
    const direction = req.query.direction as "in" | "out" | undefined;
    res.json({ conditions: await conditions.list({
      keyword: String(req.query.q ?? ""),
      direction: direction === "in" || direction === "out" ? direction : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      workId: req.query.workId ? Number(req.query.workId) : undefined
    }) });
  }));

  router.get("/conditions/:id", asyncRoute(async (req, res) => {
    const detail = await conditions.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "条件が見つかりません" });
    // OUT条件なら、作品の権利包絡と照合した結果を添える。
    let envelopeCheck = null;
    if (detail.direction === "out" && detail.work) {
      const envelope = await works.envelope(detail.work.id);
      if (envelope) envelopeCheck = { envelope, check: checkAgainstEnvelope(detail, envelope) };
    }
    res.json({ ...detail, envelopeCheck });
  }));

  const reasonSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
  router.post("/documents/:id/void", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { reason } = reasonSchema.parse(req.body ?? {});
      res.json(await issues.void(Number(req.params.id), reason, actor(res)));
    }));
  // 作り直し。間違った条件を指していたときは、ここで差し替える。
  // 発行済みの文書自体は書き換えない（出したものの記録なので）。
  const reissueSchema = reasonSchema.extend({
    conditionIds: z.array(z.number().int().positive()).max(200).optional()
  });
  router.post("/documents/:id/reissue", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { reason, conditionIds } = reissueSchema.parse(req.body ?? {});
      res.status(201).json(await issues.reissue(
        Number(req.params.id), reason, actor(res), conditionIds));
    }));

  /**
   * 下敷きにして次を作る。発注書から検収書、契約書から覚書、同じ発注のもう1枚。
   * 前の文書は退かない（訂正版とは別の入口）。
   */
  const deriveSchema = z.object({
    templateKey: z.string().trim().min(1).max(60).nullable().optional(),
    conditionIds: z.array(z.coerce.number().int().positive()).max(200).optional()
  });
  router.post("/documents/:id/derive", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = deriveSchema.parse(req.body ?? {});
      res.status(201).json(await issues.derive(Number(req.params.id), input, actor(res)));
    }));

  // 日次の点検。画面を開かないと気づけないものを決まった時刻に洗い出す。
  // Cloud Scheduler から叩く。通知はゲートを通すので、off なら送らない。
  const jobSchema = z.object({
    notifyChannel: z.enum(["slack", "gmail"]).optional(),
    notifyTo: z.string().trim().max(300).optional()
  });
  router.post("/jobs/daily", requireRole("admin"),
    asyncRoute(async (req, res) => {
      res.json(await dailyJob.run(jobSchema.parse(req.body ?? {})));
    }));
  // 洗い出しだけ見る（通知しない）。画面から今の状態を確かめるのに使う。
  router.get("/jobs/daily/preview", asyncRoute(async (_req, res) => {
    res.json(await dailyJob.run());
  }));

  // 受信メールの取り込み。手で1回動かして結果を見るためのもの。
  // 定期実行は /internal/jobs/mail-intake（Cloud Scheduler）。
  router.post("/jobs/mail-intake", requireRole("admin"), requireWritable,
    asyncRoute(async (req, res) => {
      const limit = Number((req.body ?? {}).limit);
      res.json(await mailJob.run({ limit: Number.isFinite(limit) ? limit : undefined }));
    }));

  // 経理提出用の帳票（V1 互換レイアウト）。列名も順番も V1 から変えない。
  const accountingSchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    basis: z.enum(["due", "paid"]).optional(),
    includeExported: z.coerce.boolean().optional()
  });

  // 画面で中身を確かめてから出す。要確認が残ったまま出さないため。
  router.get("/exports/accounting", asyncRoute(async (req, res) => {
    res.json(await accounting.build(accountingSchema.parse(req.query)));
  }));

  // 束ね1つ分の Excel。groupKey は preview の key をそのまま渡す。
  router.get("/exports/accounting.xls", asyncRoute(async (req, res) => {
    const query = accountingSchema.parse(req.query);
    const result = await accounting.build(query);
    const wanted = String(req.query.groupKey ?? "");
    const groups = wanted ? result.groups.filter((g) => g.key === wanted) : result.groups;
    if (!groups.length) return res.status(404).json({ error: "対象の束がありません" });

    const breakdown = req.query.layout === "breakdown";
    // 束ごとに合計行を挟む。V1 も束ごとに1ファイルだった。
    const rows = groups.flatMap((g) => [...g.rows, totalRow(g)]);
    const label = breakdown ? "内訳一覧" : "経理提出用";
    const sheet = groups.length === 1
      ? `${label}_${groups[0].paymentDate || "期日未設定"}`
      : label;

    res.setHeader("content-type", `${XLS_MIME}; charset=utf-8`);
    res.setHeader("content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(xlsFilename([
        label, groups.length === 1 ? groups[0].owner : null,
        groups.length === 1 ? groups[0].paymentDate : `${query.from}_${query.to}`
      ]))}`);
    res.send(withXlsBom(toXls(sheet, breakdown ? BREAKDOWN_COLUMNS : ACCOUNTING_COLUMNS, rows)));
  }));

  const markSchema = z.object({ paymentIds: z.array(z.number().int().positive()).min(1).max(1000),
                                batchKey: z.string().trim().max(200).optional() });
  router.post("/exports/accounting/mark", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { paymentIds, batchKey } = markSchema.parse(req.body ?? {});
      res.json({ recorded: await accountingLedger.markExported(paymentIds, batchKey ?? "", actor(res)) });
    }));

  router.post("/exports/accounting/unmark", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { paymentIds } = markSchema.parse(req.body ?? {});
      res.json({ removed: await accountingLedger.unmark(paymentIds, actor(res)) });
    }));

  // 支払を条件へ割り当てる。これが無いと「どの取り決めに対する支払か」が
  // 追えず、債権の未収も出せない。
  router.get("/payments/:id/allocation-candidates", asyncRoute(async (req, res) => {
    res.json({ candidates: await allocations.candidates(Number(req.params.id)) });
  }));
  const allocationSchema = z.object({
    lines: z.array(z.object({
      conditionId: z.coerce.number().int().positive(),
      eventId: z.coerce.number().int().positive().nullable().optional(),
      amount: z.coerce.number().int()
    })).max(100)
  });
  router.put("/payments/:id/allocations", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { lines } = allocationSchema.parse(req.body ?? {});
      res.json(await allocations.replace(Number(req.params.id), lines, actor(res)));
    }));

  // 債権マップ。許諾で得るはずの額と入った額の差。
  router.get("/monitoring/receivables", asyncRoute(async (_req, res) => {
    res.json(await receivables.map());
  }));

  // 契約チェック。依頼の前に自分で確かめる。読み取りだけなので誰でも使える。
  router.get("/contract-check", asyncRoute(async (req, res) => {
    res.json(await contractCheck.check(String(req.query.q ?? "")));
  }));

  // 名寄せ。参照は付け替えず、統合先まで辿って解決する。
  router.get("/parties/merge/candidates", asyncRoute(async (_req, res) => {
    res.json({ candidates: await partyMerge.candidates() });
  }));
  const mergeSchema = z.object({
    fromId: z.coerce.number().int().positive(),
    intoId: z.coerce.number().int().positive()
  });
  router.get("/parties/merge/preview", asyncRoute(async (req, res) => {
    const { fromId, intoId } = mergeSchema.parse(req.query ?? {});
    res.json(await partyMerge.preview(fromId, intoId));
  }));
  router.post("/parties/merge", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { fromId, intoId } = mergeSchema.parse(req.body ?? {});
      res.json(await partyMerge.merge(fromId, intoId, actor(res)));
    }));
  router.post("/parties/:id/unmerge", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await partyMerge.unmerge(Number(req.params.id), actor(res)));
    }));

  // CSV の一括取込。必ず先に試算（dryRun）を通す。
  router.get("/imports", asyncRoute(async (_req, res) => {
    res.json({ specs: IMPORT_SPECS });
  }));
  const importSchema = z.object({
    kind: z.enum(["parties", "works"]),
    csv: z.string().min(1).max(2_000_000),
    dryRun: z.boolean()
  });
  router.post("/imports", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = importSchema.parse(req.body ?? {});
      res.json(await imports.run({ ...input, kind: input.kind as ImportKind, actor: actor(res) }));
    }));

  // 支払報告書。相手先ごとに期間内の支払を明細と合計で出す。
  const reportSchema = z.object({
    from: z.string().date(),
    to: z.string().date(),
    basis: z.enum(["due", "paid"]).optional(),
    partyId: z.coerce.number().int().positive().optional()
  });
  router.get("/reports/payments", asyncRoute(async (req, res) => {
    const q = reportSchema.parse(req.query ?? {});
    res.json(await paymentReport.build(q));
  }));

  // 一覧の全件出力。画面の一覧には上限があるので、経理提出や
  // V1 との突き合わせにはこちらを使う。
  router.get("/exports", asyncRoute(async (_req, res) => {
    res.json({ datasets: DATASETS });
  }));
  router.get("/exports/:dataset.csv", asyncRoute(async (req, res) => {
    const dataset = String(req.params.dataset) as Dataset;
    if (!DATASETS.some((d) => d.key === dataset)) {
      throw new DomainError("NOT_FOUND", `出力できない一覧です: ${dataset}`);
    }
    const { csv, rows } = await exports.csv(dataset);
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename(dataset))}`);
    res.setHeader("x-row-count", String(rows));
    res.send(withBom(csv));
  }));

  // 横断検索。2文字未満は引かない（全件走査になるだけで役に立たない）。
  router.get("/search", asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 100);
    if (q.length < 2) return res.json({ query: q, results: [] });
    res.json({ query: q, results: await search.search(q) });
  }));

  // ---------------------------------------------------------------------
  // 新規登録
  //   V3 で新しく始める取引はここから入る。移行してきたデータの編集経路
  //   （patch 系）と同じ検証規則を通す。
  // ---------------------------------------------------------------------

  const partySchema = z.object({
    name: z.string().trim().min(1).max(300),
    kind: z.enum(["corporate", "individual"]),
    nameKana: z.string().trim().max(300).nullable().optional(),
    aliases: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    invoiceNo: z.string().trim().max(40).nullable().optional(),
    corporateNo: z.string().trim().max(40).nullable().optional(),
    withholding: z.boolean().optional(),
    // 書類の頭書き・宛先に出る連絡先。入れる口が無く、移行と CSV 取込で
    // 入ったきりだった。
    address: z.string().trim().max(500).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    partyCode: z.string().trim().max(40).nullable().optional(),
    allowDuplicate: z.boolean().optional()
  });
  router.post("/parties", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { allowDuplicate, ...input } = partySchema.parse(req.body ?? {});
      res.status(201).json(await partyWrites.create(input, actor(res), { allowDuplicate }));
    }));

  /**
   * 取引先を直す。登録はできても直せず、名前の誤りも住所の欠けも SQL でしか
   * 直せなかった。書類の宛名・頭書き・インボイス番号はここから出る。
   */
  const partyPatchSchema = partySchema
    .omit({ allowDuplicate: true, partyCode: true })
    .partial()
    .extend({ status: z.enum(["active", "archived"]).optional() });
  router.patch("/parties/:id", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await partyWrites.update(
        Number(req.params.id), partyPatchSchema.parse(req.body ?? {}), actor(res)));
    }));

  const contactSchema = z.object({
    role: z.string().trim().min(1).max(40),
    name: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().email().max(300).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(),
    department: z.string().trim().max(200).nullable().optional()
  });
  /**
   * 取引先の口座。読むのも直すのも admin / legal だけ。
   *
   * 取引先の詳細（誰でも見られる）は銀行名・支店名・種別しか返さない。
   * 口座番号と名義はこの経路にだけ出す。
   */
  const bankSchema = z.object({
    bankName: z.string().trim().max(120).nullable().optional(),
    branchName: z.string().trim().max(120).nullable().optional(),
    accountType: z.string().trim().max(20).nullable().optional(),
    accountNumber: z.string().trim().max(40).nullable().optional(),
    accountHolderKana: z.string().trim().max(200).nullable().optional()
  });
  router.get("/parties/:id/bank-account",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      res.json(await parties.bankAccount(Number(req.params.id)));
    }));
  router.put("/parties/:id/bank-account",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = bankSchema.parse(req.body ?? {});
      res.json(await partyWrites.saveBankAccount(Number(req.params.id), input, actor(res)));
    }));

  router.put("/parties/:id/contacts", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await partyWrites.upsertContact(
        Number(req.params.id), contactSchema.parse(req.body ?? {}), actor(res)));
    }));

  const workSchema = z.object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(["own", "source_ip", "derivative"]).optional(),
    titleKana: z.string().trim().max(300).nullable().optional(),
    businessLine: z.string().trim().max(120).nullable().optional(),
    status: z.enum(["planning", "in_production", "released", "archived"]).optional(),
    remarks: z.string().trim().max(2000).nullable().optional(),
    workCode: z.string().trim().max(40).nullable().optional(),
    parentWorkId: z.coerce.number().int().positive().nullable().optional()
  });
  router.post("/works", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await workWrites.create(workSchema.parse(req.body ?? {}), actor(res)));
    }));

  const partSchema = z.object({
    name: z.string().trim().min(1).max(300),
    partType: z.string().trim().max(60).optional(),
    royaltyBearing: z.boolean().optional(),
    remarks: z.string().trim().max(2000).nullable().optional(),
    partNo: z.coerce.number().int().positive().nullable().optional()
  });
  router.post("/works/:id/parts", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await workWrites.addPart(
        Number(req.params.id), partSchema.parse(req.body ?? {}), actor(res)));
    }));

  const matterSchema = z.object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(["work", "outsourcing", "single"]),
    documentStyle: z.enum(["counterparty_review", "own_draft", "own_template"])
      .nullable().optional(),
    ownerStaffId: z.coerce.number().int().positive().nullable().optional(),
    counterpartyId: z.coerce.number().int().positive().nullable().optional(),
    requesterEmail: z.string().trim().email().max(300).nullable().optional(),
    dueOn: z.string().date().nullable().optional(),
    remarks: z.string().trim().max(4000).nullable().optional(),
    matterNo: z.string().trim().max(40).nullable().optional()
  });
  router.post("/matters", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await matterWrites.create(matterSchema.parse(req.body ?? {}), actor(res)));
    }));

  // 進め方は後から決まることが多い（相手方から文書が来て初めて他社レビューだと分かる）ので、
  // 登録時だけでなく後からも入れられるようにする。既存案件は全部未設定なのでここが唯一の入口。
  const docStyleSchema = z.object({
    documentStyle: z.enum(["counterparty_review", "own_draft", "own_template"]).nullable()
  });
  router.patch("/matters/:id/document-style", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { documentStyle } = docStyleSchema.parse(req.body ?? {});
      res.json(await matterWrites.changeDocumentStyle(
        Number(req.params.id), documentStyle, actor(res)));
    }));

  /**
   * 取引モデル。案件が扱うものを決めるので、作るときに間違えると後戻りできなかった。
   * 繋がっている条件が新しいモデルで使えないときは断る（理由と条件番号を返す）。
   */
  const matterKindSchema = z.object({ kind: z.enum(["work", "outsourcing", "single"]) });
  router.patch("/matters/:id/kind", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { kind } = matterKindSchema.parse(req.body ?? {});
      res.json(await matterWrites.changeKind(Number(req.params.id), kind, actor(res)));
    }));

  /**
   * 案件の担当者。検収書の【ご連絡先】はここから部署・氏名・メールを差す。
   * 作るときにしか決められず、あとから直せなかった。
   */
  const matterOwnerSchema = z.object({
    ownerStaffId: z.coerce.number().int().positive().nullable()
  });
  router.patch("/matters/:id/owner", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { ownerStaffId } = matterOwnerSchema.parse(req.body ?? {});
      res.json(await matterWrites.changeOwner(Number(req.params.id), ownerStaffId, actor(res)));
    }));

  const matterStatusSchema = z.object({
    status: z.enum(["open", "waiting", "blocked", "done", "canceled"]),
    blockedReason: z.string().trim().max(1000).nullable().optional()
  });
  router.patch("/matters/:id/status", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { status, blockedReason } = matterStatusSchema.parse(req.body ?? {});
      res.json(await matterWrites.changeStatus(
        Number(req.params.id), status, actor(res), blockedReason));
    }));

  const taskSchema = z.object({
    title: z.string().trim().min(1).max(300),
    taskType: z.string().trim().max(60).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    assigneeStaffId: z.coerce.number().int().positive().nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional()
  });
  router.post("/matters/:id/tasks", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await matterWrites.addTask(
        Number(req.params.id), taskSchema.parse(req.body ?? {}), actor(res)));
    }));

  const conditionSchema = z.object({
    matterId: z.coerce.number().int().positive().optional(),
    name: z.string().trim().min(1).max(300),
    direction: z.enum(["in", "out"]),
    kind: z.enum(["license", "product", "service", "expense", "fee"]),
    counterpartyId: z.coerce.number().int().positive(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    workId: z.coerce.number().int().positive().nullable().optional(),
    workPartId: z.coerce.number().int().positive().nullable().optional(),
    exclusivity: z.enum(["exclusive", "non_exclusive"]).nullable().optional(),
    sublicensable: z.boolean().nullable().optional(),
    termStart: z.string().date().nullable().optional(),
    termEnd: z.string().date().nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    pricingModel: z.enum(["fixed", "unit_rate", "revenue_rate", "subscription", "none"]).optional(),
    ratePpm: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
    unitAmount: z.coerce.number().int().nullable().optional(),
    flatAmount: z.coerce.number().int().nullable().optional(),
    mgAmount: z.coerce.number().int().nullable().optional(),
    agAmount: z.coerce.number().int().nullable().optional(),
    taxCategory: z.enum(["taxable", "reduced", "exempt"]).optional(),
    paymentTerms: z.string().trim().max(500).nullable().optional(),
    cycle: z.string().trim().max(60).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    spec: z.string().trim().max(4000).nullable().optional(),
    deliverableOwnership: z.enum(["orderer", "contractor"]).nullable().optional(),
    // 外部で出した発注書の番号。V3 で出した発注書があればそちらを優先する。
    orderNo: z.string().trim().max(60).nullable().optional(),
    conditionNo: z.string().trim().max(40).nullable().optional(),
    scopes: z.array(z.object({
      scopeType: z.enum(["region", "language", "media", "channel"]),
      label: z.string().trim().min(1).max(120),
      code: z.string().trim().max(40).nullable().optional()
    })).max(200).optional()
  });
  router.post("/conditions", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = conditionSchema.parse(req.body ?? {});
      res.status(201).json(await conditionWrites.create(
        { ...input, scopes: input.scopes?.map((s) => ({ ...s, code: s.code ?? null })) },
        actor(res)));
    }));

  const paymentSchema = z.object({
    partyId: z.coerce.number().int().positive(),
    direction: z.enum(["in", "out"]),
    amount: z.coerce.number().int().min(0),
    currency: z.string().trim().length(3).optional(),
    taxAmount: z.coerce.number().int().min(0).optional(),
    withholdingAmount: z.coerce.number().int().min(0).optional(),
    basisReceivedOn: z.string().date().nullable().optional(),
    dueOn: z.string().date().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional()
  });
  router.post("/payments", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await payments.create(paymentSchema.parse(req.body ?? {}), actor(res)));
    }));

  const counterpartySchema = z.object({ partyId: z.coerce.number().int().positive() });
  router.patch("/conditions/:id/counterparty",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { partyId } = counterpartySchema.parse(req.body ?? {});
      res.json(await conditionWrites.changeCounterparty(Number(req.params.id), partyId, actor(res)));
    }));

  const economicsSchema = z.object({
    name: z.string().trim().min(1).max(300).optional(),
    ratePpm: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
    flatAmount: z.coerce.number().int().nullable().optional(),
    unitAmount: z.coerce.number().int().nullable().optional(),
    mgAmount: z.coerce.number().int().nullable().optional(),
    agAmount: z.coerce.number().int().nullable().optional(),
    termStart: z.string().date().nullable().optional(),
    termEnd: z.string().date().nullable().optional(),
    paymentTerms: z.string().trim().max(300).nullable().optional(),
    taxCategory: z.enum(["taxable", "reduced", "exempt"]).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    workId: z.coerce.number().int().positive().nullable().optional(),
    exclusivity: z.enum(["exclusive", "non_exclusive"]).nullable().optional(),
    spec: z.string().trim().max(4000).nullable().optional(),
    deliverableOwnership: z.enum(["orderer", "contractor"]).nullable().optional(),
    orderNo: z.string().trim().max(60).nullable().optional()
  });
  // effectiveFrom に未来の日付を渡すと「予約された改訂」になる。
  // 契約変更を締結した日に記録できないと、適用開始日まで人が覚えているしかない。
  router.patch("/conditions/:id",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { effectiveFrom, ...patch } = economicsSchema.extend({
        effectiveFrom: z.string().date().nullable().optional()
      }).parse(req.body ?? {});
      res.json(await conditionWrites.updateEconomics(
        Number(req.params.id), patch, actor(res), effectiveFrom ?? null));
    }));

  // 改訂の履歴。契約変更で金額を直すと版が増える。どれが生きているかを返す。
  router.get("/conditions/:id/revisions", asyncRoute(async (req, res) => {
    res.json({ revisions: await conditions.revisions(Number(req.params.id)) });
  }));

  // 予定明細。毎月28万円の1年契約なら12行並ぶ。
  // 状態は保存せず、実績と支払の割当から導く。
  router.get("/conditions/:id/schedules", asyncRoute(async (req, res) => {
    res.json({ ...await conditionSchedules.list(Number(req.params.id)),
               triggers: TRIGGER_KINDS, eventTypes: EVENT_TYPES,
               eventTypeByTrigger: EVENT_TYPE_BY_TRIGGER });
  }));

  const scheduleLine = z.object({
    seq: z.coerce.number().int().min(1).max(999),
    label: z.string().trim().max(120).nullable().optional(),
    triggerKind: z.enum(["on_execution", "on_delivery", "on_inspection", "periodic"]),
    plannedAmount: z.coerce.number().int(),
    // 発生予定日。実績にするときの発生日の既定値になる。
    dueOn: z.string().date().nullable().optional(),
    // 支払期日。支払条件から導けなければ空のまま。
    payOn: z.string().date().nullable().optional()
  });
  router.put("/conditions/:id/schedules",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { lines } = z.object({ lines: z.array(scheduleLine).max(200) }).parse(req.body ?? {});
      res.json(await conditionSchedules.replace(
        Number(req.params.id),
        lines.map((l) => ({
          ...l, label: l.label ?? null, dueOn: l.dueOn ?? null, payOn: l.payOn ?? null
        })),
        actor(res)));
    }));

  // 定期の明細を組み立てる。保存はせず、並びを返すだけ（画面で直してから保存する）。
  const generateSchema = z.object({
    startOn: z.string().date(),
    count: z.coerce.number().int().min(1).max(120),
    everyMonths: z.coerce.number().int().min(1).max(12).optional(),
    amount: z.coerce.number().int().positive(),
    triggerKind: z.enum(["on_execution", "on_delivery", "on_inspection", "periodic"]).optional(),
    labelSuffix: z.string().trim().max(20).optional(),
    // 画面で上書きしたいときだけ。既定は条件の支払条件。
    paymentTerms: z.string().trim().max(300).nullable().optional()
  });
  router.post("/conditions/:id/schedules/generate",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const input = generateSchema.parse(req.body ?? {});
      // 支払条件は条件が持っている。画面から入れ直させない。
      const condition = await conditions.find(Number(req.params.id));
      res.json({ lines: generateLines({
        startOn: input.startOn, count: input.count,
        everyMonths: input.everyMonths ?? 1, amount: input.amount,
        triggerKind: input.triggerKind ?? "periodic", labelSuffix: input.labelSuffix,
        paymentTerms: input.paymentTerms ?? condition?.paymentTerms ?? null
      }) });
    }));

  // 実績（条件明細の数値）。記録は消さず、取り消しは void で残す。
  // 検収書がそのまま使う項目。実績に入れておけば文書を作るとき人が入れずに済む。
  const inspectionFields = {
    deliverable: z.string().trim().max(2000).nullable().optional(),
    inspectedOn: z.string().date().nullable().optional(),
    inspectorDept: z.string().trim().max(120).nullable().optional(),
    inspectorName: z.string().trim().max(120).nullable().optional()
  };

  // 予定明細を実績に移す。予定と実績を繋ぐのは condition_events.schedule_id
  // だけで、これまで書く処理が無かった。
  const recordSchema = z.object({
    occurredOn: z.string().date().nullable().optional(),
    amount: z.coerce.number().int().nullable().optional(),
    eventType: z.enum(["manufacturing", "sales", "sublicense_receipt",
                       "inspection", "delivery", "service_period", "adjustment"]).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    quantity: z.coerce.number().nullable().optional(),
    ...inspectionFields
  });
  router.post("/conditions/:id/schedules/:scheduleId/record",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = recordSchema.parse(req.body ?? {});
      res.status(201).json(await conditionSchedules.record(
        Number(req.params.id), Number(req.params.scheduleId), input, actor(res)));
    }));

  router.get("/conditions/:id/events", asyncRoute(async (req, res) => {
    res.json({ events: await conditionEvents.list(Number(req.params.id)), types: EVENT_TYPES });
  }));

  const eventSchema = z.object({
    eventType: z.enum(["manufacturing", "sales", "sublicense_receipt",
                       "inspection", "delivery", "service_period", "adjustment"]),
    occurredOn: z.string().date(),
    period: z.string().trim().max(60).nullable().optional(),
    quantity: z.coerce.number().nullable().optional(),
    sampleQuantity: z.coerce.number().nullable().optional(),
    grossAmount: z.coerce.number().int().nullable().optional(),
    deductions: z.coerce.number().int().min(0).optional(),
    amount: z.coerce.number().int(),
    note: z.string().trim().max(1000).nullable().optional(),
    // どの予定の回か。分納の支払日はここが繋がっていないと空になる。
    scheduleId: z.coerce.number().int().positive().nullable().optional(),
    ...inspectionFields
  });
  router.post("/conditions/:id/events",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.status(201).json(await conditionEvents.add(
        Number(req.params.id), eventSchema.parse(req.body ?? {}), actor(res)));
    }));

  router.post("/conditions/:id/events/:eventId/void",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { reason } = reasonSchema.parse(req.body ?? {});
      res.json(await conditionEvents.void(
        Number(req.params.id), Number(req.params.eventId), reason, actor(res)));
    }));

  const scopesSchema = z.object({
    scopes: z.array(z.object({
      scopeType: z.enum(["region", "language", "media", "channel"]),
      label: z.string().trim().min(1).max(120),
      code: z.string().trim().max(20).nullable().optional()
    })).max(200)
  });
  // 実績から文書を作る。検収書がこれにあたる。
  //
  // 下書き・発行・紐付けはそれぞれ別のトランザクションで走る（既存の発行経路を
  // 壊さないため）。途中で落ちたときは、できたところまでを返す。発行済みの文書に
  // 後から紐づけ直せるように、link だけの経路も別に置いてある。
  const eventDocSchema = z.object({
    templateKey: z.string().trim().min(1).max(120),
    eventIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).optional()
  });
  router.post("/conditions/:id/event-documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = eventDocSchema.parse(req.body ?? {});
      const conditionId = Number(req.params.id);
      const draft = await issues.createDraft({
        templateKey: input.templateKey, conditionIds: [conditionId],
        matterId: input.matterId ?? null, manualInputs: input.manualInputs ?? {}
      }, actor(res));
      // 発行は必須項目が埋まっていないと弾かれる。下書きを残すと、
      // 押し直すたびに使われない行が積もるので、その場で捨てる。
      let issued;
      try {
        issued = await issues.issue(draft.id, actor(res));
      } catch (error) {
        await issues.void(draft.id, "発行できなかったため破棄", actor(res)).catch(() => undefined);
        throw error;
      }
      const linked = await conditionEvents.linkDocument(
        conditionId, input.eventIds, issued.id, actor(res));
      res.status(201).json({ document: issued, ...linked });
    }));

  // 発行済みの文書に実績を後から紐づける。上の経路が途中で落ちたときの復旧口。
  const linkDocSchema = z.object({
    documentId: z.coerce.number().int().positive(),
    eventIds: z.array(z.coerce.number().int().positive()).min(1).max(200)
  });
  router.post("/conditions/:id/events/link-document",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = linkDocSchema.parse(req.body ?? {});
      res.json(await conditionEvents.linkDocument(
        Number(req.params.id), input.eventIds, input.documentId, actor(res)));
    }));

  // 結びつけを外す。移行文書を結び直す作業では取り違えが起きるので、直せる道を残す。
  router.post("/conditions/:id/events/unlink-document",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = linkDocSchema.parse(req.body ?? {});
      res.json(await conditionEvents.unlinkDocument(
        Number(req.params.id), input.eventIds, input.documentId, actor(res)));
    }));

  router.put("/conditions/:id/scopes",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { scopes } = scopesSchema.parse(req.body ?? {});
      res.json(await conditionWrites.replaceScopes(
        Number(req.params.id),
        scopes.map((s) => ({ ...s, code: s.code ?? null })),
        actor(res)));
    }));

  // ---- 作品 ----
  router.get("/works", asyncRoute(async (req, res) => {
    res.json({ works: await works.list(String(req.query.q ?? "")) });
  }));

  router.get("/works/:id/envelope", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const envelope = await works.envelope(id);
    if (!envelope) return res.status(404).json({ error: "作品が見つかりません" });
    res.json({ envelope, parts: await works.parts(id) });
  }));

  /**
   * 作品にぶら下がっている動き。
   *
   * 作品の画面は取得条件と展開条件までしか見せていなかった。ライセンスは
   * 作品が軸で、実績も計算書も支払も作品にぶら下がる。条件の画面へ1本ずつ
   * 入って数え直さないと「この作品はいくら生んだのか」が読めなかった。
   */
  router.get("/works/:id/activity", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const [events, statements, payments, documents] = await Promise.all([
      database.query(
        `SELECT e.id, e.event_type, e.occurred_on, e.period, e.quantity, e.amount,
                c.id AS condition_id, c.condition_no, c.name AS condition_name, c.currency,
                d.id AS document_id, d.document_no
           FROM condition_events e
           JOIN conditions c ON c.id = e.condition_id
           LEFT JOIN documents d ON d.id = e.document_id
          WHERE c.work_id = $1 AND e.status = 'active'
          ORDER BY e.occurred_on DESC NULLS LAST, e.id DESC
          LIMIT 100`, [id]),
      database.query(
        `SELECT s.id, s.period, s.currency, s.net_amount, s.tax_amount,
                c.condition_no, c.name AS condition_name,
                d.id AS document_id, d.document_no, d.status AS document_status
           FROM statements s
           JOIN conditions c ON c.id = s.condition_id
           JOIN documents d ON d.id = s.document_id
          WHERE c.work_id = $1
          ORDER BY s.id DESC
          LIMIT 100`, [id]),
      database.query(
        `SELECT DISTINCT p.id, p.payment_no, p.direction, p.currency, p.amount,
                p.tax_amount, p.withholding_amount, p.due_on, p.paid_on, p.status,
                pt.name AS party_name
           FROM payments p
           JOIN payment_allocations a ON a.payment_id = p.id
           JOIN conditions c ON c.id = a.condition_id
           LEFT JOIN parties pt ON pt.id = p.party_id
          WHERE c.work_id = $1
          ORDER BY p.id DESC
          LIMIT 100`, [id]),
      database.query(
        `SELECT DISTINCT d.id, d.document_no, d.status, d.issued_at,
                COALESCE(t.label, t.template_key) AS template_label
           FROM documents d
           JOIN document_conditions dc ON dc.document_id = d.id
           JOIN conditions c ON c.id = dc.condition_id
           LEFT JOIN document_template_versions tv ON tv.id = d.template_version_id
           LEFT JOIN document_templates t ON t.id = tv.template_id
          WHERE c.work_id = $1
          ORDER BY d.id DESC
          LIMIT 100`, [id])
    ]);
    res.json({
      events: (events.rows as Array<Record<string, any>>).map((e) => ({
        id: Number(e.id), eventType: String(e.event_type),
        occurredOn: dateStr(e.occurred_on),
        period: e.period ? String(e.period) : null,
        quantity: e.quantity === null ? null : Number(e.quantity),
        amount: Number(e.amount ?? 0), currency: String(e.currency ?? "JPY"),
        conditionId: Number(e.condition_id),
        conditionNo: e.condition_no ? String(e.condition_no) : null,
        conditionName: String(e.condition_name),
        documentId: e.document_id === null ? null : Number(e.document_id),
        documentNo: e.document_no ? String(e.document_no) : null
      })),
      statements: (statements.rows as Array<Record<string, any>>).map((s) => ({
        id: Number(s.id), period: String(s.period), currency: String(s.currency),
        netAmount: Number(s.net_amount ?? 0), taxAmount: Number(s.tax_amount ?? 0),
        conditionNo: s.condition_no ? String(s.condition_no) : null,
        conditionName: String(s.condition_name),
        documentId: Number(s.document_id),
        documentNo: s.document_no ? String(s.document_no) : null,
        documentStatus: String(s.document_status)
      })),
      payments: (payments.rows as Array<Record<string, any>>).map((p) => ({
        id: Number(p.id), paymentNo: p.payment_no ? String(p.payment_no) : null,
        direction: String(p.direction), currency: String(p.currency),
        amount: Number(p.amount ?? 0), taxAmount: Number(p.tax_amount ?? 0),
        withholdingAmount: Number(p.withholding_amount ?? 0),
        dueOn: dateStr(p.due_on),
        paidOn: dateStr(p.paid_on),
        status: String(p.status),
        partyName: p.party_name ? String(p.party_name) : null
      })),
      documents: (documents.rows as Array<Record<string, any>>).map((d) => ({
        id: Number(d.id), documentNo: d.document_no ? String(d.document_no) : null,
        status: String(d.status),
        issuedAt: d.issued_at ? new Date(String(d.issued_at)).toISOString() : null,
        templateLabel: d.template_label ? String(d.template_label) : null
      }))
    });
  }));

  router.get("/integrations", (_req, res) => {
    res.json({
      drive: { documents: storage.configured, matterFolders: matterFolders.configured },
      channels: (["slack", "gmail", "cloudsign", "backlog"] as IntegrationChannel[]).map((channel) => ({
        channel,
        mode: config.integrationModes[channel],
        configured: Boolean(adapters[channel]?.configured)
      })),
      allowlist: config.dispatchAllowlist,
      // 受信の設定。ラベルが空なら取り込みは動かない。
      inbound: { mail: Boolean(mailSource?.configured) }
    });
  });

  // ---- 文書 ----
  /**
   * システムの外で作られた文書の登録（取込文書）。
   *
   * 本文はファイルそのものなので JSON に載せず、生のまま受ける。base64 に
   * すると 25MB のPDFが 34MB になり、上限に当たる。付随する情報はクエリで渡す。
   * 全体の JSON パーサは application/json しか読まないので、ここは素通りしてくる。
   */
  const importQuerySchema = z.object({
    title: z.string().trim().min(1).max(300),
    documentKind: z.string().trim().max(120).optional(),
    conditionIds: z.string().trim().optional(),
    matterId: z.coerce.number().int().positive().optional(),
    agreementId: z.coerce.number().int().positive().optional(),
    receivedOn: z.string().date().optional(),
    note: z.string().trim().max(2000).optional(),
    filename: z.string().trim().max(300).optional()
  });
  router.post("/documents/import",
    requireRole("admin", "legal"), requireWritable,
    express.raw({ type: () => true, limit: "26mb" }),
    asyncRoute(async (req, res) => {
      const q = importQuerySchema.parse(req.query);
      const ids = (q.conditionIds ?? "").split(",").map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      res.status(201).json(await documentImports.import({
        title: q.title, documentKind: q.documentKind ?? null,
        conditionIds: ids, matterId: q.matterId ?? null, agreementId: q.agreementId ?? null,
        receivedOn: q.receivedOn ?? null, note: q.note ?? null,
        file: {
          filename: q.filename ?? q.title,
          mimeType: String(req.headers["content-type"] ?? "").split(";")[0].trim(),
          data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
        }
      }, actor(res)));
    }));

  // 取り込みが使える状態か。設定されていないボタンを画面に出さないため。
  router.get("/documents/import-status", (_req, res) => {
    res.json({ configured: documentImports.configured });
  });

  router.get("/document-templates", asyncRoute(async (_req, res) => {
    res.json({ templates: await documents.listTemplates() });
  }));

  router.get("/documents", asyncRoute(async (req, res) => {
    res.json({ documents: await documents.list({
      keyword: String(req.query.q ?? ""),
      status: req.query.status ? String(req.query.status) : undefined,
      matterId: req.query.matterId ? Number(req.query.matterId) : undefined,
      // 条件明細が繋がっていないものだけ。移行文書の繋ぎ直しの入口。
      unlinked: String(req.query.unlinked ?? "") === "1",
      phase: (["draft", "decided", "sent", "superseded", "void"] as const)
        .find((p) => p === String(req.query.phase ?? "")),
      batchId: req.query.batchId ? Number(req.query.batchId) : undefined
    }) });
  }));

  // ---- 発注書の一括作成（束）。/documents/:id より前に置く（:id に "batches" が当たる）----
  router.get("/documents/batches", asyncRoute(async (_req, res) => {
    res.json({ batches: await batches.list() });
  }));
  router.get("/documents/batches/template.csv", (_req, res) => {
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="purchase_orders.csv"');
    res.send(templateCsv());
  });
  const batchInput = z.object({
    templateKey: z.string().trim().min(1).max(60),
    matterId: z.coerce.number().int().positive(),
    csv: z.string().min(1).max(2_000_000),
    choices: z.record(z.string(), z.coerce.number().int().positive()).default({})
  });
  // 突き合わせ。何も作らない。
  router.post("/documents/batches/preview", requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      res.json(await batches.preview(batchInput.parse(req.body ?? {})));
    }));
  router.post("/documents/batches", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = batchInput.extend({ filename: z.string().trim().max(200).nullable().optional() })
        .parse(req.body ?? {});
      res.status(201).json(await batches.create(input, actor(res)));
    }));
  router.get("/documents/batches/:id", asyncRoute(async (req, res) => {
    const batch = await batches.find(Number(req.params.id));
    if (!batch) return res.status(404).json({ error: "一括作成の束が見つかりません" });
    res.json(batch);
  }));
  router.post("/documents/batches/:id/issue", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await batches.issueAll(Number(req.params.id), actor(res)));
    }));
  router.post("/documents/batches/:id/send", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({
        subject: z.string().trim().max(300).nullable().optional(),
        body: z.string().trim().max(20000).nullable().optional()
      }).parse(req.body ?? {});
      res.json(await batches.sendAll(Number(req.params.id), input, actor(res)));
    }));

  router.get("/documents/:id", asyncRoute(async (req, res) => {
    const detail = await documents.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "文書が見つかりません" });
    res.json(detail);
  }));

  const reportedSchema = z.object({
    salesInput: z.coerce.number().int().nullable().optional(),
    intakeCurrency: z.string().trim().length(3).nullable().optional(),
    fxRate: z.coerce.number().positive().nullable().optional(),
    quantity: z.coerce.number().nonnegative().nullable().optional(),
    sampleQuantity: z.coerce.number().nonnegative().nullable().optional(),
    acceptanceRatio: z.coerce.number().min(0).max(1).nullable().optional(),
    periodCount: z.coerce.number().int().positive().nullable().optional(),
    initialFee: z.coerce.number().int().nullable().optional()
  }).default({});

  const calculationSchema = z.object({
    // 実績の束から出すときは省ける（実績の期間から導く）。
    period: z.string().trim().max(60).nullable().optional(),
    occurredOn: z.string().date().nullable().optional(),
    eventType: z.enum(["manufacturing", "sales", "sublicense_receipt", "service_period", "adjustment"]).optional(),
    reported: reportedSchema,
    /** 実績の束。選んだ実績の根拠を合算して1回計算し、実績は新しく作らない。 */
    eventIds: z.array(z.coerce.number().int().positive()).max(500).optional()
  });

  const draftSchema = z.object({
    templateKey: z.string().trim().min(1).max(60),
    conditionIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).default({}),
    // 候補に出すための文脈。プレビューでは値を見せるだけで、保存はしない。
    eventIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    royalty: z.record(z.string(), z.unknown()).nullable().optional()
  });

  // 発行せずに中身と未入力を確認する。
  /**
   * ひな形ごとの「前回入れた値」。
   *
   * 検収者部署・検収者氏名のように、毎回同じで、条件からも実績からも
   * 出てこない項目がある。覚えておかないと毎回打つことになる。
   *
   * 日付と金額は覚えない。毎回変わるものを既定に入れると、前回の日付が
   * 入ったまま気づかず発行してしまう。
   */
  router.get("/document-defaults/:templateKey", asyncRoute(async (req, res) => {
    const r = await database.query(
      "SELECT value FROM settings WHERE key = $1",
      [`document_defaults:${req.params.templateKey}`]);
    res.json({ defaults: (r.rows[0] as { value?: Record<string, unknown> })?.value ?? {} });
  }));

  const defaultsSchema = z.object({
    values: z.record(z.string(), z.string().max(300))
  });
  router.put("/document-defaults/:templateKey",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { values } = defaultsSchema.parse(req.body ?? {});
      const key = `document_defaults:${req.params.templateKey}`;
      await database.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(values), actor(res)]);
      res.json({ saved: Object.keys(values).length });
    }));

  /**
   * 引用元の検索。
   *
   * 条件や案件から辿れない人（別の部署の検収者、相手先の別の担当者）は
   * 候補に出てこない。名前で探して引けるようにする。最小入力で書類を
   * 作るという建て付けは、探して引けることまで含めて成り立つ。
   */
  /**
   * 入力欄の「探して入れる」で引ける値。
   *
   * 人（スタッフ・取引先・先方担当）は名前で横断して引く。相手先の別の担当者や
   * 別部署の検収者を入れたいことがあるので、ここは絞らない。
   * 契約と文書は partyId を渡したときだけ、その取引先のぶんを返す。基本契約名の
   * ような欄は「この相手との契約」から選ぶもので、他社の契約が並ぶと選び間違える。
   */
  router.get("/quote-sources", requireRole("admin", "legal"), asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    const partyId = Number(req.query.partyId) > 0 ? Number(req.query.partyId) : null;
    // 取引先が決まっていれば、打つ前でもその取引先の契約と文書を並べる。
    if (q.length < 1 && !partyId) return res.json({ candidates: [] });
    const like = `%${q}%`;
    // 人は名前を打ってから引く。空で引くと、関係の無い8人が並ぶ。
    const none = { rows: [] as Array<Record<string, any>> };
    const staff = q.length < 1 ? none : await database.query(
      `SELECT name, email, department, phone, staff_code FROM staff
        WHERE status = 'active'
          AND (name ILIKE $1 OR department ILIKE $1 OR email ILIKE $1 OR staff_code ILIKE $1)
        ORDER BY department NULLS LAST, name LIMIT 8`, [like]);
    const partyRows = q.length < 1 ? none : await database.query(
      // 住所・電話・メールは取引先そのものが持つ列。書類の頭書きと宛先に出る
      // のに、ここで拾っていなかったので「探して入れる」に出てこなかった。
      `SELECT p.id, p.name, p.name_kana, p.invoice_no, p.corporate_no, p.kind,
              p.address, p.phone, p.email
         FROM parties p
        WHERE p.status = 'active'
          AND (p.name ILIKE $1 OR p.name_kana ILIKE $1 OR p.email ILIKE $1)
        ORDER BY p.name LIMIT 8`, [like]);
    const contacts = q.length < 1 ? none : await database.query(
      `SELECT c.role, c.name, c.email, c.phone, c.department, p.name AS party_name
         FROM party_contacts c JOIN parties p ON p.id = c.party_id
        WHERE c.name ILIKE $1 OR c.department ILIKE $1 OR c.email ILIKE $1
        ORDER BY p.name LIMIT 8`, [like]);

    // 契約と文書は取引先のぶんだけ。基本契約名はここから選ぶ。
    const agreements = partyId ? await database.query(
      `SELECT agreement_no, title, status, executed_on
         FROM agreements
        WHERE counterparty_id = $1
          AND ($2 = '' OR title ILIKE $3 OR COALESCE(agreement_no, '') ILIKE $3)
        ORDER BY executed_on DESC NULLS LAST, id DESC LIMIT 10`,
      [partyId, q, like]) : { rows: [] as Array<Record<string, any>> };
    const docs = partyId ? await database.query(
      `SELECT document_no, title, template_label
         FROM v_document_display
        WHERE counterparty_id = $1 AND status <> 'void'
          AND ($2 = '' OR title ILIKE $3 OR COALESCE(document_no, '') ILIKE $3)
        ORDER BY issued_at DESC NULLS LAST, document_id DESC LIMIT 10`,
      [partyId, q, like]) : { rows: [] as Array<Record<string, any>> };

    const out: Array<{ label: string; value: string; source: string; kind: string }> = [];
    const push = (source: string, label: string, value: unknown) => {
      const text = String(value ?? "").trim();
      if (!text || out.some((o) => o.label === label && o.value === text)) return;
      out.push({ label, value: text, source, kind: "text" });
    };
    // 同じ件名の文書は何枚もある（計算書は毎期出る）。入る値が同じなら、
    // 並べても選び分けられないので1つにする。
    const once = (source: string, label: string, value: unknown) => {
      const text = String(value ?? "").trim();
      if (!text || out.some((o) => o.source === source && o.value === text)) return;
      out.push({ label, value: text, source, kind: "text" });
    };
    // 探しているのはたいてい契約名なので、人より先に並べる。
    // 番号は打って絞ったときだけ出す。空で開いたときは「何があるか」を
    // 見せる場面で、番号まで並べると件名が埋もれる（計算書は毎期出るので
    // 同じ件名の番号が10個並ぶ）。
    const withNumbers = q.length > 0;
    for (const r of agreements.rows as Array<Record<string, any>>) {
      const no = r.agreement_no ? String(r.agreement_no) : "番号なし";
      once("契約", `${no} の件名`, r.title);
      if (withNumbers) once("契約", `${r.title ?? no} の番号`, r.agreement_no);
    }
    for (const r of docs.rows as Array<Record<string, any>>) {
      const no = r.document_no ? String(r.document_no) : "（下書き）";
      const kind = r.template_label ? String(r.template_label) : "文書";
      once("文書", `${no}（${kind}）の件名`, r.title);
      if (withNumbers) once("文書", `${r.title ?? kind} の文書番号`, r.document_no);
    }
    for (const r of staff.rows as Array<Record<string, any>>) {
      push("スタッフ", `${r.name} の氏名`, r.name);
      push("スタッフ", `${r.name} の部署`, r.department);
      push("スタッフ", `${r.name} のメール`, r.email);
      push("スタッフ", `${r.name} の電話`, r.phone);
    }
    for (const r of partyRows.rows as Array<Record<string, any>>) {
      push("取引先", `${r.name} の名称`, r.name);
      push("取引先", `${r.name} の宛名`,
           `${r.name} ${r.kind === "individual" ? "様" : "御中"}`);
      push("取引先", `${r.name} のカナ`, r.name_kana);
      push("取引先", `${r.name} のメール`, r.email);
      push("取引先", `${r.name} の電話`, r.phone);
      push("取引先", `${r.name} の住所`, r.address);
      push("取引先", `${r.name} のインボイス番号`, r.invoice_no);
      push("取引先", `${r.name} の法人番号`, r.corporate_no);
    }
    for (const r of contacts.rows as Array<Record<string, any>>) {
      push("先方担当", `${r.party_name} ${r.name ?? ""} の氏名`, r.name);
      push("先方担当", `${r.party_name} ${r.name ?? ""} の部署`, r.department);
      push("先方担当", `${r.party_name} ${r.name ?? ""} のメール`, r.email);
      push("先方担当", `${r.party_name} ${r.name ?? ""} の電話`, r.phone);
    }
    // 1件の名前で引いても、取引先と先方担当で 10 件を超える。24 で切ると
    // あとに並ぶ先方担当がまるごと落ちていた。
    res.json({ candidates: out.slice(0, 60) });
  }));

  /**
   * 発行せずに中身を見る。
   *
   * 計算書は試算が無いと金額欄が空になる。押してから「金額が入っていない」と
   * 気づくのでは遅いので、プレビューでも同じ試算を通す。
   */
  const previewSchema = draftSchema.extend({
    royaltyInput: calculationSchema.nullable().optional()
  });
  router.post("/documents/preview",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const parsed = previewSchema.parse(req.body ?? {});
      const { royaltyInput, ...rest } = parsed;
      const input = { ...rest };
      if (royaltyInput && rest.conditionIds.length === 1) {
        const preview = await royalty.preview({
          conditionId: rest.conditionIds[0], period: royaltyInput.period,
          occurredOn: royaltyInput.occurredOn, eventType: royaltyInput.eventType,
          reported: royaltyInput.reported
        });
        input.royalty = royaltyForDocument(preview, royaltyInput.reported);
      }
      const result = await issues.preview(input);
      res.json({
        html: result.html,
        templateLabel: result.templateLabel,
        missing: result.binding.missing,
        derived: result.binding.derived,
        values: result.binding.values,
        // 画面に出す項目の一覧。区分と出どころ（計算／自動／手入力）付き。
        fields: result.binding.fields,
        // 入力欄の横に出す候補。ひな形が供給元を宣言していなくても人が選べる。
        candidates: result.candidates,
        // 本文が差しているのに空で出る項目（振込先の欠けなど）。
        warnings: result.warnings,
        // 明細の欄と、その種になる行。
        lines: result.lines,
        // 計算書か。画面は金額の枠（対象期間・実績・試算）をこれで出し分ける。
        statement: isStatementTemplate(parsed.templateKey)
      });
    }));

  router.post("/documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = draftSchema.parse(req.body ?? {});
      res.status(201).json(await issues.createDraft(input, actor(res)));
    }));

  /**
   * 下書きの中身を直す。
   *
   * 作り直した下書きは元の手入力をそのまま引き継ぐ。直せないと、間違いを
   * 含んだまま発行するか捨てるかの二択になる。
   */
  const draftPatchSchema = z.object({
    manualInputs: z.record(z.string(), z.unknown()).optional(),
    conditionIds: z.array(z.coerce.number().int().positive()).max(200).optional()
  });
  router.patch("/documents/:id/draft",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = draftPatchSchema.parse(req.body ?? {});
      res.json(await issues.updateDraft(Number(req.params.id), input, actor(res)));
    }));

  /**
   * 実績を条件ごとに分け、どの条件も文書に繋がっていることを確かめる。
   * 検収書は委託料と実費のように条件をまたいで1枚にできるので、
   * 「最初の条件」だけを見てはいけない。
   */
  const eventGroupsFor = async (conditionIds: number[], eventIds: number[], noConditionHint: string) => {
    const groups = await conditionEvents.groupByCondition(eventIds);
    if (groups.size && !conditionIds.length) {
      throw new DomainError("VALIDATION", `実績を結ぶには、${noConditionHint}`);
    }
    const allowed = new Set(conditionIds.map(Number));
    for (const conditionId of groups.keys()) {
      if (!allowed.has(conditionId)) {
        throw new DomainError("VALIDATION",
          `条件 #${conditionId} の実績が選ばれていますが、その条件はこの文書に繋がっていません。` +
          "条件明細も一緒に選んでください");
      }
    }
    return groups;
  };

  // 実績は下書きに保存していないので、発行のときに渡せるようにする。
  const issueSchema = z.object({
    eventIds: z.array(z.coerce.number().int().positive()).max(200).default([])
  });
  router.post("/documents/:id/issue",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { eventIds } = issueSchema.parse(req.body ?? {});
      const id = Number(req.params.id);
      const who = actor(res);
      const draft = await documents.find(id);
      if (!draft) throw new DomainError("NOT_FOUND", `文書 ${id} が見つかりません`);

      // 先に確かめる。発行してから弾かれると、番号だけ振られた文書が残る。
      // 実績は条件をまたいでよい（委託料と実費を1枚の検収書に）。条件ごとに分けて、
      // その条件が文書に繋がっているかと、結べるかを見る。
      // 訂正版なら、前の版が持っている実績は空いているものとして扱う
      // （発行の瞬間にこちらへ移る）。
      const groups = await eventGroupsFor(draft.conditions.map((c) => c.id), eventIds, "先に条件明細を繋いでください");
      for (const [conditionId, ids] of groups) {
        await conditionEvents.assertLinkable(conditionId, ids, draft.supersedesId);
      }

      const issued = await issues.issue(id, who, eventIds.length ? { eventIds } : {});
      // 前の版から移らなかったぶんを結ぶ。すでにこの文書を指している実績は
      // linkDocument 側で素通りする。
      for (const [conditionId, ids] of groups) {
        await conditionEvents.linkDocument(conditionId, ids, id, who);
      }
      res.json(issued);
    }));

  router.get("/documents/:id/html", asyncRoute(async (req, res) => {
    const rendered = await issues.renderIssued(Number(req.params.id));
    res.type("html").send(rendered.html);
  }));

  // Drive への保存。発行済みの文書だけ。既存ファイルがあれば中身を差し替えてリンクを保つ。
  router.post("/documents/:id/store",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const force = String(req.query.force ?? "") === "1";
      res.json(await storage.store(Number(req.params.id), actor(res), { force }));
    }));

  // ローカル保存（DRIVE_STORAGE=local）のファイルを返す。Drive の閲覧リンクの代わり。
  // 認証の内側（/api/v3）に置くので、予備系でも誰でも開けるファイルにはならない。
  router.get("/local-files/:id", asyncRoute(async (req, res) => {
    if (!(drive instanceof LocalFileStorage)) throw new DomainError("NOT_FOUND", "ローカル保存は使っていません");
    const file = await drive.downloadFile(String(req.params.id));
    res.type(file.mimeType)
       .setHeader("content-disposition",
         `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.send(file.data);
  }));

  router.get("/documents/:id/pdf", asyncRoute(async (req, res) => {
    const rendered = await issues.renderIssued(Number(req.params.id));
    const buffer = await pdf.render(rendered.html);
    res.type("application/pdf")
       .setHeader("content-disposition",
         `attachment; filename="${rendered.documentNo ?? `document-${req.params.id}`}.pdf"`);
    res.send(buffer);
  }));

  // ---- ロイヤリティ ----
  // 試算。保存しない。
  router.post("/conditions/:id/royalty-preview",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const input = calculationSchema.parse(req.body ?? {});
      res.json(await royalty.preview({ conditionId: Number(req.params.id), ...input }));
    }));

  // 確定。発行済みの計算書（文書）に結び付ける。金額は必ず計算し直す。
  router.post("/conditions/:id/statements",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = calculationSchema.extend({
        documentId: z.coerce.number().int().positive()
      }).parse(req.body ?? {});
      res.status(201).json(await royalty.finalize({ conditionId: Number(req.params.id), ...input }, actor(res)));
    }));

  // 条件から計算書を作る。文書を先に発行してから結び付ける手順は、
  // 実務の順番（条件があって、期の売上が出て、計算書を出す）と逆だった。
  // ここは 下書き → 発行 → 確定 を1操作にまとめる。金額は確定時に計算し直す。
  router.post("/conditions/:id/statement-documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = calculationSchema.extend({
        templateKey: z.string().trim().min(1).max(120),
        matterId: z.coerce.number().int().positive().nullable().optional(),
        manualInputs: z.record(z.string(), z.unknown()).optional()
      }).parse(req.body ?? {});
      const conditionId = Number(req.params.id);
      // 先に試算する。渡さないと本文の金額欄が全部空のまま発行される
      // （計算書だけが「紙は出るが数字が無い」状態になっていた）。
      const preview = await royalty.preview({
        conditionId, period: input.period, occurredOn: input.occurredOn,
        eventType: input.eventType, reported: input.reported, eventIds: input.eventIds
      });
      // 実績の束から出したときは、導いた報告値と期間で本文を作る。
      const computed = royaltyForDocument(preview, preview.reported);
      const draft = await issues.createDraft({
        templateKey: input.templateKey, conditionIds: [conditionId],
        matterId: input.matterId ?? null, manualInputs: input.manualInputs ?? {}
      }, actor(res));
      let issued;
      try {
        issued = await issues.issue(draft.id, actor(res),
          { royalty: computed, eventIds: input.eventIds ?? [] });
      } catch (error) {
        await issues.void(draft.id, "発行できなかったため破棄", actor(res)).catch(() => undefined);
        throw error;
      }
      const statement = await royalty.finalize({
        conditionId, period: preview.period, occurredOn: preview.occurredOn,
        eventType: input.eventType, reported: preview.reported, eventIds: input.eventIds,
        documentId: issued.id
      }, actor(res));
      res.status(201).json({ document: issued, ...statement });
    }));

  /**
   * 条件をまたいだ計算書（束ね）。
   *
   * 作品ひとつに取引モデルが何本もある（自社製造・自社販売、再許諾…）とき、
   * 相手先に出す計算書は1枚で、中は取引モデルごとの内訳になる。V1・V2 では
   * これを手入力の表（rs_bundle）で作っていて、金額はテンプレート側で
   * 計算し直していた。ここは条件ごとに試算し、その結果を印字し、条件ごとに
   * 計算書を1本ずつ結ぶ。書類とデータベースの金額は同じ計算から出す。
   */
  const bundleSchema = z.object({
    templateKey: z.string().trim().min(1).max(120),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).default({}),
    entries: z.array(calculationSchema.extend({
      conditionId: z.coerce.number().int().positive()
    })).min(1).max(50)
  });

  type BundleEntries = z.infer<typeof bundleSchema>["entries"];
  const previewBundle = async (entries: BundleEntries) => {
    const ids = entries.map((e) => e.conditionId);
    if (new Set(ids).size !== ids.length) {
      throw new DomainError("VALIDATION", "同じ条件を2回は選べません");
    }
    // 直列に試算する。AG の消化累計は条件ごとに読むので順番に意味は無いが、
    // 弾かれた理由を条件ごとに返せるようにしておく。
    const previews = [];
    for (const entry of entries) {
      previews.push(await royalty.preview({
        conditionId: entry.conditionId, period: entry.period, occurredOn: entry.occurredOn,
        eventType: entry.eventType, reported: entry.reported, eventIds: entry.eventIds
      }));
    }
    return previews;
  };

  // 試算。保存しない。1枚にまとめたときの内訳と合計を返す。
  router.post("/statement-documents/preview",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const input = bundleSchema.omit({ templateKey: true }).extend({
        templateKey: z.string().trim().max(120).optional()
      }).parse(req.body ?? {});
      const previews = await previewBundle(input.entries);
      res.json({
        lines: previews.map(bundleLineFrom),
        totals: bundleTotals(previews),
        previews
      });
    }));

  router.post("/statement-documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = bundleSchema.parse(req.body ?? {});
      const who = actor(res);
      const previews = await previewBundle(input.entries);
      const totals = bundleTotals(previews);
      const lines = previews.map(bundleLineFrom);
      const eventIds = input.entries.flatMap((e) => e.eventIds ?? []);

      const draft = await issues.createDraft({
        templateKey: input.templateKey,
        conditionIds: input.entries.map((e) => e.conditionId),
        matterId: input.matterId ?? null,
        agreementId: input.agreementId ?? null,
        // 本文はここに焼き付けた行から描く。計算済みなので、印字のときに
        // 計算し直さない（rs_bundle_lines を royalty-patch が拾う）。
        manualInputs: {
          ...input.manualInputs,
          statementMode: "bundle",
          rs_bundle_lines: lines,
          rs_bundle_tax: totals.tax
        }
      }, who);

      let issued;
      try {
        issued = await issues.issue(draft.id, who, { eventIds });
      } catch (error) {
        await issues.void(draft.id, "発行できなかったため破棄", who).catch(() => undefined);
        throw error;
      }
      // 金額は確定時にもう一度計算し直す（V1・V2 と同じ防御）。ここで弾かれたら
      // 文書を無効にする。番号の振られた紙だけが残って、計算書の無い計算書に
      // なるのを防ぐ。
      let statements;
      try {
        statements = await royalty.finalizeAll(
          input.entries.map((e) => ({
            conditionId: e.conditionId, period: e.period, occurredOn: e.occurredOn,
            eventType: e.eventType, reported: e.reported, eventIds: e.eventIds,
            documentId: issued.id
          })), who);
      } catch (error) {
        await issues.void(issued.id, "計算書を結べなかったため無効", who).catch(() => undefined);
        throw error;
      }
      res.status(201).json({ document: issued, statements, totals, lines });
    }));

  /**
   * 文書を作る（1本化した入口）。
   *
   * 計算書は「先に試算 → その値で発行 → 確定」の順にする。逆にすると、
   * 本文を固めたあとに金額を計算することになり、書類に金額が載らない。
   */
  const composeSchema = z.object({
    templateKey: z.string().trim().min(1).max(120),
    conditionIds: z.array(z.coerce.number().int().positive()).max(50).default([]),
    eventIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).default({}),
    /** 入れると計算書として確定する。条件は1件だけ。 */
    royalty: z.object({
      period: z.string().trim().min(1).max(60),
      occurredOn: z.string().date().nullable().optional(),
      eventType: z.enum(["manufacturing", "sales", "sublicense_receipt",
                         "service_period", "adjustment"]).optional(),
      reported: reportedSchema
    }).nullable().optional()
  });
  router.post("/documents/compose",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = composeSchema.parse(req.body ?? {});
      const who = actor(res);

      // 1. 計算書なら先に試算する。書類に載せる金額はここで決まる。
      let computed: Record<string, unknown> | null = null;
      if (input.royalty) {
        if (input.conditionIds.length !== 1) {
          throw new DomainError("VALIDATION", "計算書は条件を1件だけ選んでください");
        }
        const preview = await royalty.preview({
          conditionId: input.conditionIds[0], period: input.royalty.period,
          occurredOn: input.royalty.occurredOn, eventType: input.royalty.eventType,
          reported: input.royalty.reported
        });
        computed = royaltyForDocument(preview, input.royalty.reported);
      }

      // 2. 実績に結びつけられるかを先に確かめる。発行してから弾かれると、
      //    番号の振られた文書だけが残る。実績は条件をまたいでよい。
      const groups = await eventGroupsFor(input.conditionIds, input.eventIds, "その条件も選んでください");
      for (const [conditionId, ids] of groups) {
        await conditionEvents.assertLinkable(conditionId, ids, null);
      }

      // 3. 下書き → 発行。失敗したら下書きは捨てる。
      const draft = await issues.createDraft({
        templateKey: input.templateKey, conditionIds: input.conditionIds,
        matterId: input.matterId ?? null, agreementId: input.agreementId ?? null,
        manualInputs: input.manualInputs
      }, who);
      let issued;
      try {
        issued = await issues.issue(draft.id, who,
          { eventIds: input.eventIds, royalty: computed });
      } catch (error) {
        await issues.void(draft.id, "発行できなかったため破棄", who).catch(() => undefined);
        throw error;
      }

      // 4. 実績に結びつける／計算書を確定する。金額は確定時に計算し直す。
      let linked: { linked: number; documentNo: string | null } | null = null;
      for (const [conditionId, ids] of groups) {
        const r = await conditionEvents.linkDocument(conditionId, ids, issued.id, who);
        const before: number = linked ? linked.linked : 0;
        linked = { linked: before + r.linked, documentNo: r.documentNo };
      }
      const statement = input.royalty
        ? await royalty.finalize({
            conditionId: input.conditionIds[0], period: input.royalty.period,
            occurredOn: input.royalty.occurredOn, eventType: input.royalty.eventType,
            reported: input.royalty.reported, documentId: issued.id
          }, who)
        : null;

      res.status(201).json({ document: issued, linked, statement, royalty: computed });
    }));

  router.get("/statements", asyncRoute(async (req, res) => {
    res.json({ statements: await royalty.list({
      conditionId: req.query.conditionId ? Number(req.query.conditionId) : undefined
    }) });
  }));

  router.get("/balances", asyncRoute(async (_req, res) => {
    res.json({ balances: await conditions.balances() });
  }));

  // ---- 支払 ----
  router.get("/payments", asyncRoute(async (req, res) => {
    const direction = req.query.direction as "in" | "out" | undefined;
    res.json({ payments: await payments.list({
      status: req.query.status ? String(req.query.status) : undefined,
      direction: direction === "in" || direction === "out" ? direction : undefined
    }) });
  }));

  /**
   * 文書から支払を起こす。
   *
   * 当社の支払は検収書か利用許諾計算書のどちらかから起きる。文書の画面を
   * ひとつの入口にして、どちらの書類かで振り分ける。経理提出用の一覧は
   * 支払から作られるので、ここを通らないと経理に出ない。
   */
  router.post("/documents/:id/payment",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = z.object({ dueOn: z.string().date().nullable().optional() }).parse(req.body ?? {});
      // 計算書は1枚に条件のぶんだけ行が並ぶ（束ね）。先頭の1本だけ見ると、
      // 残りの条件の金額が支払から落ちる。文書ごとにまとめて立てる。
      const found = await database.query(
        "SELECT count(*)::int AS n FROM statements WHERE document_id = $1", [id]);
      const hasStatement = Number((found.rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
      res.status(201).json(hasStatement
        ? await payments.createFromStatementDocument(id, actor(res),
                                                     { dueOn: input.dueOn ?? undefined })
        : await payments.createFromInspection(id, actor(res),
                                              { dueOn: input.dueOn ?? undefined }));
    }));

  // 計算書から支払を起こす。割当なしでは作れない。
  // 支払は計算書ではなく「文書1枚」につき1件。束ねた計算書は1枚に条件のぶんだけ
  // 行が並ぶので、行ごとに支払を立てると相手先1社への支払が何件にも割れる。
  router.post("/statements/:id/payment",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ dueOn: z.string().date().nullable().optional() }).parse(req.body ?? {});
      const found = await database.query(
        "SELECT document_id FROM statements WHERE id = $1", [Number(req.params.id)]);
      const row = found.rows[0] as { document_id: number } | undefined;
      if (!row) throw new DomainError("NOT_FOUND", `計算書 ${req.params.id} が見つかりません`);
      res.status(201).json(await payments.createFromStatementDocument(
        Number(row.document_id), actor(res), { dueOn: input.dueOn ?? undefined }));
    }));

  router.post("/payments/:id/paid",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ paidOn: z.string().date() }).parse(req.body ?? {});
      res.json(await payments.markPaid(Number(req.params.id), input.paidOn, actor(res)));
    }));

  // ---- 取引先・担当者 ----
  router.get("/parties", asyncRoute(async (req, res) => {
    res.json({ parties: await parties.list(String(req.query.q ?? "")) });
  }));

  router.get("/parties/:id", asyncRoute(async (req, res) => {
    const detail = await parties.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "取引先が見つかりません" });
    res.json(detail);
  }));

  /**
   * 自社の担当者を直す。検収書の【ご連絡先】はここから来る。
   * 移行で入れたきり直す経路が無く、メールが空のまま書類に出ていた。
   */
  const staffPatchSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().max(200).nullable().optional(),
    department: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(),
    status: z.enum(["active", "retired"]).optional()
  });
  router.patch("/staff/:id",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = staffPatchSchema.parse(req.body ?? {});
      res.json(await partyWrites.updateStaff(Number(req.params.id), input, actor(res)));
    }));

  router.get("/staff", asyncRoute(async (_req, res) => {
    res.json({ staff: await parties.staff() });
  }));

  // ---- フロー監視（案件をまたぐ集計）----
  router.get("/monitoring/works", asyncRoute(async (_req, res) => {
    res.json({ works: await monitoring.workMonitor() });
  }));

  router.get("/monitoring/outsourcing", asyncRoute(async (_req, res) => {
    res.json({ pipeline: await monitoring.outsourcingPipeline() });
  }));

  // ---- 運用 ----
  router.get("/summary", asyncRoute(async (_req, res) => {
    res.json(await ops.summary());
  }));

  router.get("/deadlines", asyncRoute(async (req, res) => {
    res.json({ deadlines: await ops.deadlines(req.query.days ? Number(req.query.days) : 30) });
  }));

  router.get("/quality-issues", asyncRoute(async (req, res) => {
    res.json({ issues: await ops.issues(String(req.query.status ?? "open")) });
  }));

  router.post("/quality-issues/:id/resolve",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ mode: z.enum(["resolved", "ignored"]).default("resolved") }).parse(req.body ?? {});
      res.json(await ops.resolveIssue(Number(req.params.id), actor(res), input.mode));
    }));

  router.get("/audit-events", asyncRoute(async (req, res) => {
    res.json({ events: await ops.auditEvents({
      action: req.query.action ? String(req.query.action) : undefined,
      targetType: req.query.targetType ? String(req.query.targetType) : undefined
    }) });
  }));

  router.get("/settings", requireRole("admin"), asyncRoute(async (_req, res) => {
    res.json({ settings: await ops.settings() });
  }));

  router.put("/settings/:key",
    requireRole("admin"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ value: z.unknown() }).parse(req.body ?? {});
      const key = String(req.params.key);
      // 自社情報だけは形を確かめる。書類に差し込む先が決まっているので、
      // 打ち間違えたキーが黙って入ると、どこにも出ないまま「入れたつもり」になる。
      const value = key === "company_profile"
        ? parseCompanyProfile(input.value) : input.value;
      res.json(await ops.saveSetting(key, value, actor(res)));
    }));

  // ---- 外部送信 ----
  // ---- 送る：内容確認のメール → 相手の確認 → CloudSign → 締結 ----
  router.get("/documents/:id/sends", asyncRoute(async (req, res) => {
    res.json(await sends.timeline(Number(req.params.id)));
  }));

  /** 決定済みの文書の PDF。送付と署名依頼で使う。 */
  const pdfOf = async (id: number) => {
    const document = await documents.find(id);
    if (!document) throw new DomainError("NOT_FOUND", `文書 ${id} が見つかりません`);
    if (document.status !== "issued") {
      throw new DomainError("CONFLICT", "決定済みの文書だけ送れます（下書きは先に決定してください）");
    }
    // 取り込んだ文書（外で作って登録したもの）はひな形が無いので描けない。
    // 登録のときに Drive へ置いたファイルをそのまま添える。
    if (document.imported) {
      const fileId = driveIdFromUrl(document.storageUrl ?? "");
      if (!fileId || !drive || typeof drive.downloadFile !== "function") {
        throw new DomainError("VALIDATION",
          "取り込んだ文書のファイルを Drive から読めません（Drive 保存が未設定か、保存先が無い）");
      }
      const file = await drive.downloadFile(fileId);
      const ext = file.mimeType === "application/pdf" ? "pdf"
        : String(document.manualInputs?.filename ?? "").split(".").pop() || "bin";
      return {
        document,
        attachment: { filename: `${document.documentNo ?? `document-${id}`}.${ext}`,
                      mimeType: file.mimeType, data: file.data }
      };
    }
    const rendered = await issues.renderIssued(id);
    return {
      document,
      attachment: {
        filename: `${document.documentNo ?? `document-${id}`}.pdf`,
        mimeType: "application/pdf", data: await pdf.render(rendered.html)
      }
    };
  };

  /**
   * 内容確認のメール。任意（飛ばして CloudSign へ行ける）。
   * 宛先は「担当者だけ」か「取引先へ、担当者を cc に」。案件があれば
   * 案件のやり取りにも残り、スレッドに続く。
   */
  const sendSchema = z.object({
    to: z.array(z.string().trim().email()).min(1).max(20),
    cc: z.array(z.string().trim().email()).max(20).default([]),
    subject: z.string().trim().max(300).optional(),
    body: z.string().trim().min(1).max(20000),
    attachPdf: z.boolean().default(true)
  });
  router.post("/documents/:id/send",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = sendSchema.parse(req.body ?? {});
      const { document, attachment } = await pdfOf(id);
      const subject = input.subject
        ?? `${document.documentNo ?? ""} ${document.templateLabel ?? "文書"} のご確認`.trim();
      if (document.matterId) {
        return res.json(await communications.sendEmail(document.matterId, {
          to: input.to, cc: input.cc, subject, body: input.body,
          documentId: id, attachment: input.attachPdf ? attachment : null
        }, actor(res)));
      }
      // 案件の無い文書（移行文書など）。やり取りの記録先が無いので送るだけ。
      const outcome = await dispatch.dispatch({
        channel: "gmail", targetType: "document", targetId: id, actor: actor(res),
        request: { recipient: input.to.join(", "), cc: input.cc, subject, body: input.body,
                   attachment: input.attachPdf ? attachment : null }
      });
      res.json({ outcome, communication: null });
    }));

  // 相手の確認をもらった。返信・Slack・電話のどれでも、人が記録する。
  router.post("/documents/:id/confirm",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({
        via: z.string().trim().min(1).max(40),
        note: z.string().trim().max(2000).nullable().optional()
      }).parse(req.body ?? {});
      res.json(await sends.confirm(Number(req.params.id), input, actor(res)));
    }));

  // 署名依頼。書類の実体が要るので PDF は必ず付ける。
  router.post("/documents/:id/sign",
    requireRole("admin"), requireWritable,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = z.object({
        recipient: z.string().trim().email(),
        subject: z.string().trim().max(300).optional()
      }).parse(req.body ?? {});
      const { document, attachment } = await pdfOf(id);
      const subject = input.subject ?? document.title ?? document.documentNo ?? "署名のお願い";
      const who = actor(res);
      const outcome = await dispatch.dispatch({
        channel: "cloudsign", targetType: "document", targetId: id, actor: who,
        request: { recipient: input.recipient, subject, body: "署名をお願いします。", attachment }
      });
      if (outcome.sent && document.matterId) {
        await inTransaction(database, async (client) => {
          await recordCommunication(client, {
            matterId: document.matterId!, channel: "cloudsign", direction: "out", actor: who,
            counterpart: input.recipient, subject,
            body: `${document.documentNo ?? ""} の署名依頼を CloudSign で送った`,
            externalRef: outcome.externalId ?? null, documentId: id,
            evidence: { cloudSignDocumentId: outcome.externalId ?? null }
          });
        });
      }
      res.json({ outcome });
    }));

  // ---- 案件のやり取り（Slack・メール・Drive・メモ）----
  // 送信は dispatch（ゲート・冪等・監査）を通し、送れたものだけを時系列に残す。
  router.get("/matters/:id/communications", asyncRoute(async (req, res) => {
    res.json({ communications: await communications.list(Number(req.params.id)) });
  }));

  // 送る相手の候補。担当者（自社）と取引先の連絡先、Slack の宛先。
  router.get("/matters/:id/recipients", asyncRoute(async (req, res) => {
    res.json(await communications.recipients(Number(req.params.id)));
  }));

  router.post("/matters/:id/communications/note",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ body: z.string().trim().min(1).max(8000) }).parse(req.body ?? {});
      res.status(201).json(await communications.note(Number(req.params.id), input, actor(res)));
    }));

  router.post("/matters/:id/communications/slack",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({
        channelId: z.string().trim().max(60).nullable().optional(),
        threadRef: z.string().trim().max(60).nullable().optional(),
        body: z.string().trim().min(1).max(4000)
      }).parse(req.body ?? {});
      res.json(await communications.sendSlack(Number(req.params.id), input, actor(res)));
    }));

  // メール。to 担当者だけ／to 取引先 cc 担当者 のどちらかは宛先で決める。
  // 文書を添えるときは決定済みの PDF を付ける。
  router.post("/matters/:id/communications/email",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({
        to: z.array(z.string().trim().email()).min(1).max(20),
        cc: z.array(z.string().trim().email()).max(20).default([]),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(20000),
        documentId: z.coerce.number().int().positive().nullable().optional(),
        attachPdf: z.boolean().default(false)
      }).parse(req.body ?? {});
      let attachment: { filename: string; mimeType: string; data: Buffer } | null = null;
      if (input.documentId && input.attachPdf) {
        const document = await documents.find(input.documentId);
        if (!document) throw new DomainError("NOT_FOUND", `文書 ${input.documentId} が見つかりません`);
        if (document.status !== "issued") {
          throw new DomainError("CONFLICT", "決定済みの文書だけを添えられます（下書きは送れません）");
        }
        const rendered = await issues.renderIssued(input.documentId);
        attachment = {
          filename: `${document.documentNo ?? `document-${input.documentId}`}.pdf`,
          mimeType: "application/pdf", data: await pdf.render(rendered.html)
        };
      }
      res.json(await communications.sendEmail(Number(req.params.id), {
        to: input.to, cc: input.cc, subject: input.subject, body: input.body,
        documentId: input.documentId ?? null, attachment
      }, actor(res)));
    }));

  router.post("/matters/:id/communications/drive",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({
        url: z.string().trim().url().max(500),
        title: z.string().trim().max(200).nullable().optional(),
        direction: z.enum(["in", "out"]),
        note: z.string().trim().max(2000).nullable().optional()
      }).parse(req.body ?? {});
      res.status(201).json(await communications.linkDrive(Number(req.params.id), input, actor(res)));
    }));

  return router;
}

/**
 * Slack のスラッシュコマンドと対話。
 *
 * Slack は JSON ではなくフォーム形式で送ってくる（interactions は
 * payload= に JSON が入る）。署名検証には生の本文が要るので、
 * webhook と同じく express.raw の下に置く。
 *
 * Slack は3秒以内の応答を求める。モーダルを開くのは trigger_id を使った
 * views.open で、Slack の Web API を叩く必要がある。ここでは応答本文だけを
 * 組み立て、送信はアダプタに任せる。
 */
function parseForm(raw: Buffer): Record<string, string> {
  const params = new URLSearchParams(raw.toString("utf8"));
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

/** Webhook 受信。ユーザー認証は通さず、共有シークレットと署名で守る。 */
export function createWebhookRouter(database: Transactable) {
  const router = Router();
  // 受信の記録と送信は同じ設定で動かす（画面側と食い違わせない）。
  const dispatch = buildDispatch(database);
  const intake = new IntakeService(database);
  const jobs: Record<string, (body: any) => Promise<unknown>> = {
    daily: (body) => new DailyJob(database, dispatch).run({
      notifyChannel: body?.notifyChannel, notifyTo: body?.notifyTo
    }),
    "mail-intake": (body) => new MailIntakeJob(database, buildMailSource()).run({
      limit: Number(body?.limit) || undefined
    })
  };

  /** Slack の署名検証。未設定なら常に拒否（fail-closed）。 */
  const verifySlack = (req: any, raw: Buffer) => verifySlackSignature({
    signingSecret: config.slackSigningSecret,
    timestampHeader: req.header("x-slack-request-timestamp"),
    signatureHeader: req.header("x-slack-signature"),
    rawBody: raw
  });

  // スラッシュコマンド。モーダルの定義を返し、Slack 側で開かせる。
  router.post("/slack/commands", asyncRoute(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifySlack(req, raw)) return res.status(401).json({ error: "signature verification failed" });

    const form = parseForm(raw);
    if (!INTAKE_COMMANDS.has(String(form.command ?? ""))) {
      return res.json({ response_type: "ephemeral", text: "知らないコマンドです。" });
    }
    // trigger_id を添えて返す。views.open は呼び出し側（Slack アプリ）が行う。
    res.json({
      trigger_id: form.trigger_id,
      view: buildIntakeModal({ channelId: form.channel_id })
    });
  }));

  // モーダルの送信。ここで案件が立つ。
  router.post("/slack/interactions", asyncRoute(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifySlack(req, raw)) return res.status(401).json({ error: "signature verification failed" });

    const form = parseForm(raw);
    let payload: any = {};
    try { payload = JSON.parse(String(form.payload ?? "{}")); }
    catch { return res.status(400).json({ error: "payload を読み取れません" }); }

    if (payload.type !== "view_submission") return res.json({});   // 他の対話は無視

    try {
      const result = await intake.accept(parseSubmission(payload));
      // Slack はモーダルを閉じるために空の 200 を求める。文面は別途返す。
      res.json({ response_action: "clear", legalbridge: result });
    } catch (error) {
      const e = error as DomainError;
      // 入力の誤りはモーダルに出す。閉じさせない。
      return res.json({
        response_action: "errors",
        errors: { title: e?.message ?? "受け付けられませんでした" }
      });
    }
  }));

  /**
   * 定期実行の入口。Cloud Scheduler から叩く。
   *
   * 画面側の /api/v3/jobs/* は IAP のヘッダを見るので、Scheduler の OIDC
   * では通らない（毎朝401で落ちる）。ジョブは /internal に置き、
   * Cloud Run の呼び出し権限＋共有シークレットの2つで守る。
   */
  router.post("/jobs/:name", asyncRoute(async (req, res) => {
    if (!config.webhookToken || req.header("x-lb-webhook-token") !== config.webhookToken) {
      return res.status(config.webhookToken ? 401 : 404).json({ error: "unauthorized" });
    }
    const job = jobs[String(req.params.name)];
    if (!job) return res.status(404).json({ error: "unknown job", known: Object.keys(jobs) });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    let body: any = {};
    try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
    catch { return res.status(400).json({ error: "本文を読み取れません" }); }

    res.json(await job(body));
  }));

  router.post("/webhooks/:source", asyncRoute(async (req, res) => {
    const source = String(req.params.source);
    if (!["cloudsign", "backlog", "slack"].includes(source)) {
      return res.status(404).json({ error: "unknown source" });
    }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

    if (source === "slack") {
      // Slack だけは署名で検証する。未設定は常に拒否（fail-closed）。
      const ok = verifySlackSignature({
        signingSecret: config.slackSigningSecret,
        timestampHeader: req.header("x-slack-request-timestamp"),
        signatureHeader: req.header("x-slack-signature"),
        rawBody: raw
      });
      if (!ok) return res.status(401).json({ error: "signature verification failed" });
      // Events API の登録時だけ、challenge をそのまま返す（署名は上で確かめた）。
      try {
        const probe = JSON.parse(raw.toString("utf8")) as { type?: string; challenge?: string };
        if (probe?.type === "url_verification" && probe.challenge) {
          return res.json({ challenge: probe.challenge });
        }
      } catch { /* JSON でなければ普通の受信として続ける */ }
    } else {
      // 他は共有シークレット。未設定なら受け口ごと閉じる。
      if (!config.webhookToken || req.header("x-lb-webhook-token") !== config.webhookToken) {
        return res.status(config.webhookToken ? 401 : 404).json({ error: "unauthorized" });
      }
    }

    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
    catch { payload = { raw: raw.toString("utf8").slice(0, 2000) }; }

    const externalId = String(
      payload.event_id ?? payload.id ?? payload.documentID ?? payload.documentId ??
      req.header("x-lb-event-id") ?? ""
    );
    if (!externalId) return res.status(400).json({ error: "external id is required" });

    res.json(await dispatch.receiveWebhook({ source, externalId, payload }));
  }));

  return router;
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  if (error instanceof DomainError) {
    return res.status(statusFor(error.code)).json({ error: error.message, code: error.code, detail: error.detail });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: "入力が正しくありません", issues: error.issues });
  }
  console.error("unhandled error", error);
  return res.status(500).json({ error: "サーバ内部でエラーが発生しました" });
}

/**
 * 試算の結果を、書類に載せる形にする。
 * 主単位（円）の数値で渡す。テンプレートは表示用の値を使うため。
 */
/** 契約（合意）の一覧・詳細で共通の形。 */
function mapAgreement(row: Record<string, any>) {
  return {
    id: Number(row.id),
    agreementNo: row.agreement_no ?? null,
    title: String(row.title),
    direction: String(row.direction) as "in" | "out",
    status: String(row.status),
    executedOn: row.executed_on ? String(row.executed_on).slice(0, 10) : null,
    effectiveOn: row.effective_on ? String(row.effective_on).slice(0, 10) : null,
    expiresOn: row.expires_on ? String(row.expires_on).slice(0, 10) : null,
    counterparty: { id: Number(row.party_id), name: String(row.party_name) },
    conditionCount: Number(row.condition_count ?? 0),
    documentCount: Number(row.document_count ?? 0),
    totalFlat: Number(row.total_flat ?? 0)
  };
}

function royaltyForDocument(
  preview: { fee: Record<string, any>; payment: Record<string, any>; agConsumedBefore: number },
  reported: Record<string, any>
): Record<string, unknown> {
  return {
    salesInput: reported.salesInput ?? null,
    quantity: reported.quantity ?? null,
    grossExTax: preview.fee.gross_ex_tax,
    mgTopup: preview.fee.mg_topup_this_time,
    agOffset: preview.fee.ag_offset_this_time,
    agRemaining: preview.fee.ag_remaining_after,
    agConsumedBefore: preview.agConsumedBefore,
    netExTax: preview.fee.actual_ex_tax,
    taxAmount: preview.fee.tax_amount,
    totalIncTax: preview.fee.total_inc_tax,
    withholdingTax: preview.payment.withholdingTax,
    netTransfer: preview.payment.netTransfer,
    formula: preview.fee.formula_breakdown
  };
}
