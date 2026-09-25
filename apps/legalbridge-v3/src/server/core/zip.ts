/**
 * 最小の ZIP 書き出し（圧縮なし・保存のみ）。
 *
 * PDF をまとめて落とすためだけに使う。PDF はもともと圧縮されていて縮まないので、
 * 保存だけで足りる。ライブラリを足さずに済ませる（依存を増やすと本番の
 * ビルド（Cloud Build の npm ci）と予備系の両方に効く）。
 *
 * Node にも画面（ブラウザ）にも依存しない（Uint8Array と TextEncoder だけ）。
 * 画面側で 1 枚ずつ PDF を取りながら ZIP を組むと「何枚目を作っているか」を
 * 出せるので、同じ書き出しを両方から使う。
 *
 * ファイル名は UTF-8（汎用ビット 11）。Windows のエクスプローラーも macOS も
 * 日本語名をそのまま読める。
 */
export interface ZipEntry {
  /** ZIP の中のパス。区切りは `/`。 */
  name: string;
  data: Uint8Array;
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function header(size: number): { buf: Uint8Array; view: DataView } {
  const buf = new Uint8Array(size);
  return { buf, view: new DataView(buf.buffer) };
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name.replace(/\\/g, "/"));
    const { date, time } = dosDateTime(entry.mtime ?? new Date());
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);          // version needed
    local.view.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    local.view.setUint16(8, 0, true);           // method: store
    local.view.setUint16(10, time, true);
    local.view.setUint16(12, date, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, size, true);
    local.view.setUint32(22, size, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    parts.push(local.buf, name, entry.data);

    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    // version made by：上位バイトは作成元の OS。0（MS-DOS）にすると、Debian・Ubuntu の
    // unzip は UTF-8 の印があっても名前を DOS の文字コード（CP437/CP866）として読み替え、
    // 日本語名が化ける（Cloud Build の node:22 と、UTF-8 の端末で実際に起きた）。
    // 3（Unix）にすれば名前はそのまま使われる。Windows・macOS は UTF-8 の印だけを見る。
    central.view.setUint16(4, (3 << 8) | 20, true);
    central.view.setUint16(6, 20, true);        // version needed
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(10, 0, true);
    central.view.setUint16(12, time, true);
    central.view.setUint16(14, date, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, size, true);
    central.view.setUint32(24, size, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint16(30, 0, true);        // extra
    central.view.setUint16(32, 0, true);        // comment
    central.view.setUint16(34, 0, true);        // disk
    central.view.setUint16(36, 0, true);        // internal attrs
    // external attrs：Unix を名乗るので、上位 16 ビットに通常ファイルの権限（0644）を入れる。
    // 0 のままだと、展開したファイルが誰も読めない権限になる。
    central.view.setUint32(38, (0o100644 << 16) >>> 0, true);
    central.view.setUint32(42, offset, true);
    centrals.push(central.buf, name);

    offset += local.buf.length + name.length + size;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(4, 0, true);
  end.view.setUint16(6, 0, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralSize, true);
  end.view.setUint32(16, offset, true);
  end.view.setUint16(20, 0, true);

  const all = [...parts, ...centrals, end.buf];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

/** ファイル名に使えない文字を落とす（フォルダ区切りは別に組む）。 */
export function safeFileName(name: string, fallback = "無題"): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}
