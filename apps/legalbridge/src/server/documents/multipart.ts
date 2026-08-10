// multipart/form-data の依存フリーパーサ（Phase 16-4・添付アップロード基盤）。
// express.raw で受けた Buffer をそのまま解釈する。V2 は multer を導入しない方針
// （Excel パーサ同様の依存最小主義）。ブラウザの FormData が生成する CRLF 区切りを対象とする。

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartPayload {
  fields: Record<string, string>;
  files: MultipartFile[];
}

export class MultipartError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const CRLF_CRLF = Buffer.from("\r\n\r\n");

export function parseBoundary(contentTypeHeader: string | undefined): string {
  const header = String(contentTypeHeader ?? "");
  if (!/^multipart\/form-data\b/i.test(header.trim())) {
    throw new MultipartError("NOT_MULTIPART", "multipart/form-data ではありません");
  }
  const match = /boundary=(?:"([^"]+)"|([^;,\s]+))/i.exec(header);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();
  if (!boundary) throw new MultipartError("NO_BOUNDARY", "boundary がありません");
  return boundary;
}

function headerParam(headerValue: string, key: string): string | null {
  // name="..." / filename="..." を取り出す（\" は " に戻す）。filename* は未対応
  // （FE が originalName を通常フィールドで併送する前提・V1 と同じ運用）。
  const re = new RegExp(`${key}="((?:[^"\\\\]|\\\\.)*)"`, "i");
  const match = re.exec(headerValue);
  if (!match) return null;
  return match[1].replace(/\\(.)/g, "$1");
}

export function parseMultipart(body: Buffer, contentTypeHeader: string | undefined): MultipartPayload {
  const boundary = parseBoundary(contentTypeHeader);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) throw new MultipartError("MALFORMED", "boundary が本文に見つかりません");

  while (cursor !== -1) {
    let partStart = cursor + delimiter.length;
    // 終端 "--boundary--"
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    // 区切り直後の CRLF をスキップ
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;

    const headerEnd = body.indexOf(CRLF_CRLF, partStart);
    if (headerEnd === -1) throw new MultipartError("MALFORMED", "パートヘッダが不正です");
    const headerText = body.subarray(partStart, headerEnd).toString("utf8");

    const nextDelimiter = body.indexOf(delimiter, headerEnd + CRLF_CRLF.length);
    if (nextDelimiter === -1) throw new MultipartError("MALFORMED", "終端 boundary がありません");
    // データ末尾の CRLF（次の boundary の直前）を除去
    let dataEnd = nextDelimiter;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const data = body.subarray(headerEnd + CRLF_CRLF.length, dataEnd);

    const disposition = headerText.split(/\r\n/)
      .find((line) => /^content-disposition:/i.test(line)) ?? "";
    const name = headerParam(disposition, "name");
    const filename = headerParam(disposition, "filename");
    const typeLine = headerText.split(/\r\n/)
      .find((line) => /^content-type:/i.test(line));
    const contentType = typeLine ? typeLine.replace(/^content-type:\s*/i, "").trim() : "";

    if (name) {
      if (filename !== null) {
        files.push({
          field: name,
          filename,
          contentType: contentType || "application/octet-stream",
          data: Buffer.from(data)
        });
      } else {
        fields[name] = data.toString("utf8");
      }
    }
    cursor = nextDelimiter;
  }

  return { fields, files };
}
