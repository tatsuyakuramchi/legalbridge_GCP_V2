import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { Transactable } from "./core/db.js";
import { DomainError, statusFor } from "./core/errors.js";
import { requireRole, requireWritable } from "./auth.js";
import { ConditionRepository } from "./conditions/repository.js";
import { ConditionWriteService } from "./conditions/write-service.js";
import { MatterWriteService } from "./matters/write-service.js";
import { WorkWriteService } from "./works/write-service.js";
import { PartyWriteService } from "./parties/write-service.js";
import { PartyMergeService } from "./parties/merge-service.js";
import { MatterRepository } from "./matters/repository.js";
import { WorkRepository } from "./works/repository.js";
import { checkAgainstEnvelope } from "./works/envelope.js";
import { DocumentRepository } from "./documents/repository.js";
import { DocumentIssueService } from "./documents/issue-service.js";
import { ChromiumPdfRenderer, MemoryPdfRenderer, type PdfRenderer } from "./documents/pdf-renderer.js";
import { DocumentStorageService } from "./documents/storage-service.js";
import { GoogleDriveStorage, MemoryDriveStorage, type DriveStorage } from "./documents/drive-storage.js";
import { GoogleMatterDriveFolderService, LocalMatterDriveFolderService } from "./documents/drive-folder.js";
import { MatterFolderStorageService } from "./matters/drive-folder-service.js";
import { config } from "./config.js";
import { verifySlackSignature } from "./integrations/signature.js";
import { RoyaltyStatementService } from "./royalty/statement-service.js";
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

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next); };

export function createRoutes(database: Transactable) {
  const router = Router();
  const conditions = new ConditionRepository(database);
  const conditionWrites = new ConditionWriteService(database);
  const matters = new MatterRepository(database);
  const works = new WorkRepository(database);
  const documents = new DocumentRepository(database);
  const issues = new DocumentIssueService(database);
  const pdf: PdfRenderer = process.env.PDF_RENDERER === "memory"
    ? new MemoryPdfRenderer() : new ChromiumPdfRenderer();

  // Drive は未設定でも起動する。保存を呼んだときだけ 503 で理由を返す。
  const drive: DriveStorage | null =
    process.env.DRIVE_STORAGE === "memory" ? new MemoryDriveStorage()
    : config.driveFolderId
      ? new GoogleDriveStorage(config.driveFolderId, {
          keyFilePath: config.driveKeyFilePath || undefined,
          environmentTag: config.driveEnvironmentTag
        })
      : null;
  const storage = new DocumentStorageService(database, drive, pdf);
  const royalty = new RoyaltyStatementService(database);
  const payments = new PaymentService(database);
  const allocations = new PaymentAllocationService(database);
  const parties = new PartyRepository(database);
  const matterWrites = new MatterWriteService(database);
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
  router.post("/documents/:id/reissue", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { reason } = reasonSchema.parse(req.body ?? {});
      res.status(201).json(await issues.reissue(Number(req.params.id), reason, actor(res)));
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
    partyCode: z.string().trim().max(40).nullable().optional(),
    allowDuplicate: z.boolean().optional()
  });
  router.post("/parties", requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const { allowDuplicate, ...input } = partySchema.parse(req.body ?? {});
      res.status(201).json(await partyWrites.create(input, actor(res), { allowDuplicate }));
    }));

  const contactSchema = z.object({
    role: z.string().trim().min(1).max(40),
    name: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().email().max(300).nullable().optional(),
    phone: z.string().trim().max(60).nullable().optional(),
    department: z.string().trim().max(200).nullable().optional()
  });
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
    notes: z.string().trim().max(2000).nullable().optional()
  });
  router.patch("/conditions/:id",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const patch = economicsSchema.parse(req.body ?? {});
      res.json(await conditionWrites.updateEconomics(Number(req.params.id), patch, actor(res)));
    }));

  const scopesSchema = z.object({
    scopes: z.array(z.object({
      scopeType: z.enum(["region", "language", "media", "channel"]),
      label: z.string().trim().min(1).max(120),
      code: z.string().trim().max(20).nullable().optional()
    })).max(200)
  });
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
  router.get("/document-templates", asyncRoute(async (_req, res) => {
    res.json({ templates: await documents.listTemplates() });
  }));

  router.get("/documents", asyncRoute(async (req, res) => {
    res.json({ documents: await documents.list({
      keyword: String(req.query.q ?? ""),
      status: req.query.status ? String(req.query.status) : undefined,
      matterId: req.query.matterId ? Number(req.query.matterId) : undefined
    }) });
  }));

  router.get("/documents/:id", asyncRoute(async (req, res) => {
    const detail = await documents.find(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: "文書が見つかりません" });
    res.json(detail);
  }));

  const draftSchema = z.object({
    templateKey: z.string().trim().min(1).max(60),
    conditionIds: z.array(z.coerce.number().int().positive()).max(200).default([]),
    matterId: z.coerce.number().int().positive().nullable().optional(),
    agreementId: z.coerce.number().int().positive().nullable().optional(),
    manualInputs: z.record(z.string(), z.unknown()).default({})
  });

  // 発行せずに中身と未入力を確認する。
  router.post("/documents/preview",
    requireRole("admin", "legal"),
    asyncRoute(async (req, res) => {
      const input = draftSchema.parse(req.body ?? {});
      const result = await issues.preview(input);
      res.json({
        html: result.html,
        templateLabel: result.templateLabel,
        missing: result.binding.missing,
        derived: result.binding.derived,
        values: result.binding.values
      });
    }));

  router.post("/documents",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = draftSchema.parse(req.body ?? {});
      res.status(201).json(await issues.createDraft(input, actor(res)));
    }));

  router.post("/documents/:id/issue",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      res.json(await issues.issue(Number(req.params.id), actor(res)));
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

  router.get("/documents/:id/pdf", asyncRoute(async (req, res) => {
    const rendered = await issues.renderIssued(Number(req.params.id));
    const buffer = await pdf.render(rendered.html);
    res.type("application/pdf")
       .setHeader("content-disposition",
         `attachment; filename="${rendered.documentNo ?? `document-${req.params.id}`}.pdf"`);
    res.send(buffer);
  }));

  // ---- ロイヤリティ ----
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
    period: z.string().trim().min(1).max(60),
    occurredOn: z.string().date().nullable().optional(),
    eventType: z.enum(["manufacturing", "sales", "sublicense_receipt", "service_period", "adjustment"]).optional(),
    reported: reportedSchema
  });

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

  // 計算書から支払を起こす。割当なしでは作れない。
  router.post("/statements/:id/payment",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const input = z.object({ dueOn: z.string().date().nullable().optional() }).parse(req.body ?? {});
      res.status(201).json(await payments.createFromStatement(
        Number(req.params.id), actor(res), { dueOn: input.dueOn ?? undefined }));
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
      res.json(await ops.saveSetting(String(req.params.key), input.value, actor(res)));
    }));

  // ---- 外部送信 ----
  const sendSchema = z.object({
    recipient: z.string().trim().min(1).max(300),
    subject: z.string().trim().max(300).optional(),
    body: z.string().trim().min(1).max(20000),
    attachPdf: z.boolean().default(false)
  });

  // 文書をメールで送る。PDF を添付する場合は発行済みの文書から生成する。
  router.post("/documents/:id/send",
    requireRole("admin"), requireWritable,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = sendSchema.parse(req.body ?? {});
      const document = await documents.find(id);
      if (!document) return res.status(404).json({ error: "文書が見つかりません" });

      let attachment: { filename: string; mimeType: string; data: Buffer } | null = null;
      if (input.attachPdf) {
        const rendered = await issues.renderIssued(id);
        attachment = {
          filename: `${document.documentNo ?? `document-${id}`}.pdf`,
          mimeType: "application/pdf",
          data: await pdf.render(rendered.html)
        };
      }
      res.json(await dispatch.dispatch({
        channel: "gmail", targetType: "document", targetId: id, actor: actor(res),
        request: {
          recipient: input.recipient,
          subject: input.subject ?? document.title ?? document.documentNo ?? "文書の送付",
          body: input.body,
          attachment
        }
      }));
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
      const document = await documents.find(id);
      if (!document) return res.status(404).json({ error: "文書が見つかりません" });
      if (document.status !== "issued") {
        return res.status(409).json({ error: "発行済みの文書だけを署名依頼できます", code: "CONFLICT" });
      }
      const rendered = await issues.renderIssued(id);
      res.json(await dispatch.dispatch({
        channel: "cloudsign", targetType: "document", targetId: id, actor: actor(res),
        request: {
          recipient: input.recipient,
          subject: input.subject ?? document.title ?? document.documentNo ?? "署名のお願い",
          body: "署名をお願いします。",
          attachment: {
            filename: `${document.documentNo ?? `document-${id}`}.pdf`,
            mimeType: "application/pdf",
            data: await pdf.render(rendered.html)
          }
        }
      }));
    }));

  // 案件の相談スレッドへ投稿する。
  router.post("/matters/:id/notify",
    requireRole("admin", "legal"), requireWritable,
    asyncRoute(async (req, res) => {
      const id = Number(req.params.id);
      const input = z.object({
        channelId: z.string().trim().min(1).max(60),
        body: z.string().trim().min(1).max(4000),
        threadRef: z.string().trim().max(60).nullable().optional()
      }).parse(req.body ?? {});
      res.json(await dispatch.dispatch({
        channel: "slack", targetType: "matter", targetId: id, actor: actor(res),
        request: { recipient: input.channelId, body: input.body, threadRef: input.threadRef ?? null }
      }));
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
