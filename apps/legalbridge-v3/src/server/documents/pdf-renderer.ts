import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
}

export class ChromiumPdfRenderer implements PdfRenderer {
  constructor(
    private readonly executable = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser"
  ) {}

  async render(html: string) {
    const directory = await mkdtemp(path.join(tmpdir(), "legalbridge-pdf-"));
    const htmlPath = path.join(directory, "document.html");
    const pdfPath = path.join(directory, "document.pdf");
    try {
      await writeFile(htmlPath, html, "utf8");
      await execute(this.executable, [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`
      ], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      });
      return await readFile(pdfPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class MemoryPdfRenderer implements PdfRenderer {
  async render() {
    return Buffer.from("%PDF-1.4\n% LegalBridge validation PDF\n", "utf8");
  }
}
