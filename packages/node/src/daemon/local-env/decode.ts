/**
 * 流式解码与行扫描（local-env 子模块）：语义与 `@earendil-works/pi-durable`
 * 的 decode.ts / line-scan.ts 对齐——契约测试（test/node-local-env-contract.test.ts）
 * 钉住关键行为特征：chunk 化解码与整体解码逐字节一致、BOM 只在流首剥离一次、
 * LineScan 字节偏移与选区字节数口径。
 */

/** 行扫描结果（字节偏移基于原始文件字节，含 BOM；*Bytes 为解码后字节数）。 */
export interface LineScan {
  newlines: number;
  start: number;
  end: number;
  firstLineEnd: number;
  lastLineStart: number;
  selectedBytes: number;
  firstLineBytes: number;
}

/** 字节范围解码器：BOM 交给调用方处理（ignoreBOM）。 */
function rangeDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

/** 前三字节是否为 UTF-8 BOM。 */
function startsWithBom(firstBytes: Uint8Array): boolean {
  return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/**
 * 按 chunk 解码单个流，结果与整体一次解码完全一致：Node 流式解码器在
 * chunk 边界后的 U+FEFF 处理有缺陷，故关闭 BOM 处理并自行剥离流首标记。
 */
export class StreamDecoder {
  #decoder = rangeDecoder();
  #started = false;
  decode(bytes?: Uint8Array): string {
    const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
    if (this.#started || text === '') return text;
    this.#started = true;
    // U+FEFF 仅编码为 EF BB BF，流首 U+FEFF 即字节序标记。
    return text.startsWith('\ufeff') ? text.slice(1) : text;
  }
}

const NEWLINE = 0x0a;
const lineScanEncoder = new TextEncoder();

const decodedBytes = (text: string): number => (text === '' ? 0 : lineScanEncoder.encode(text).length);

/**
 * 按序喂入文件字节，产出 LineScan：任意大小文件都能在有限内存中扫描。
 * 解码字节数与整体解码相同（流式 WHATWG 解码器）。
 */
export class LineScanner {
  #startLine: number;
  #endLine: number;
  #position = 0;
  #newlines = 0;
  #lineStart = 0;
  #start?: number;
  #end?: number;
  #firstLineEnd?: number;
  #lastLineStart?: number;
  #selectedBytes = 0;
  #firstLineBytes = 0;
  #selection?: TextDecoder;
  #firstLine?: TextDecoder;
  /** 文件首字节：攒满 3 字节后判定是否 BOM。 */
  #head?: number[];
  #bom = false;

  constructor(startLine: number, endLine: number = Number.POSITIVE_INFINITY) {
    if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine)) {
      throw new RangeError('Invalid line range');
    }
    if (endLine !== Number.POSITIVE_INFINITY && !Number.isSafeInteger(endLine)) {
      throw new RangeError('Invalid line range');
    }
    this.#startLine = startLine;
    this.#endLine = endLine;
    if (startLine === 0) this.#begin(0);
  }

  push(chunk: Uint8Array): void {
    if (this.#head !== undefined) {
      const take = Math.min(3 - this.#head.length, chunk.length);
      this.#head.push(...chunk.subarray(0, take));
      if (this.#head.length < 3) return;
      this.#releaseHead();
      chunk = chunk.subarray(take);
    }
    this.#process(chunk);
  }

  #releaseHead(): void {
    const head = Uint8Array.from(this.#head ?? []);
    this.#head = undefined;
    this.#bom = startsWithBom(head);
    this.#process(head);
  }

  #process(chunk: Uint8Array): void {
    const base = this.#position;
    let from = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) {
      this.#feed(chunk, base, from, index);
      const line = this.#newlines;
      const position = base + index;
      if (line === this.#startLine) this.#endFirstLine(position);
      if (line === this.#endLine - 1) this.#endSelection(position);
      this.#feed(chunk, base, index, index + 1);
      from = index + 1;
      this.#newlines++;
      this.#lineStart = position + 1;
      if (this.#newlines === this.#startLine) this.#begin(this.#lineStart);
      if (this.#newlines === this.#endLine - 1) this.#lastLineStart = this.#lineStart;
    }
    this.#feed(chunk, base, from, chunk.length);
    this.#position += chunk.length;
  }

  finish(): LineScan {
    if (this.#head !== undefined) this.#releaseHead();
    const size = this.#position;
    if (this.#start === undefined) {
      return {
        newlines: this.#newlines,
        start: size,
        end: size,
        firstLineEnd: size,
        lastLineStart: size,
        selectedBytes: 0,
        firstLineBytes: 0,
      };
    }
    if (this.#firstLineEnd === undefined) this.#endFirstLine(size);
    if (this.#end === undefined) this.#endSelection(size);
    return {
      newlines: this.#newlines,
      start: this.#start,
      end: this.#end ?? size,
      firstLineEnd: this.#firstLineEnd ?? size,
      // 超出最后一行的选区以最后一行结束。
      lastLineStart: this.#lastLineStart ?? this.#lineStart,
      selectedBytes: this.#selectedBytes,
      firstLineBytes: this.#firstLineBytes,
    };
  }

  #begin(start: number): void {
    this.#start = start;
    if (this.#startLine === this.#endLine - 1) this.#lastLineStart = start;
    this.#selection = rangeDecoder();
    this.#firstLine = rangeDecoder();
  }

  #endFirstLine(position: number): void {
    this.#firstLineEnd = position;
    if (this.#firstLine !== undefined) this.#firstLineBytes += decodedBytes(this.#firstLine.decode());
    this.#firstLine = undefined;
  }

  #endSelection(position: number): void {
    this.#end = position;
    if (this.#selection !== undefined) this.#selectedBytes += decodedBytes(this.#selection.decode());
    this.#selection = undefined;
  }

  /** 喂 chunk[from, to)（起始于文件偏移 base）给仍打开的选区解码器。 */
  #feed(chunk: Uint8Array, base: number, from: number, to: number): void {
    // 整体解码会丢弃文件首的 BOM。
    if (this.#bom && base + from < 3) from = Math.min(to, 3 - base);
    if (to <= from) return;
    const bytes = chunk.subarray(from, to);
    if (this.#selection !== undefined) {
      this.#selectedBytes += decodedBytes(this.#selection.decode(bytes, { stream: true }));
    }
    if (this.#firstLine !== undefined) {
      this.#firstLineBytes += decodedBytes(this.#firstLine.decode(bytes, { stream: true }));
    }
  }
}
