/**
 * streaming decode and row scan (local-env sub- module): semantics and `@earendil-works/pi-durable`
 *  decode.ts / line-scan.ts align - - contract test (test/node-local-env-contract.test.ts)
 * pin key behavior special sign:chunk decode and whole decode one by one byte consistent,BOM only in stream first strip once,
 * LineScan byte offset and choose zone byte count opening path.
 */

/** row scan result (byte offset based on original file byte, contains BOM;*Bytes is decode after byte count). */
export interface LineScan {
  newlines: number;
  start: number;
  end: number;
  firstLineEnd: number;
  lastLineStart: number;
  selectedBytes: number;
  firstLineBytes: number;
}

/** byte scope decode:BOM hand over to caller handle (ignoreBOM). */
function rangeDecoder(): TextDecoder {
  return new TextDecoder('utf-8', { ignoreBOM: true });
}

/** before three byte is otherwise is UTF-8 BOM. */
function startsWithBom(firstBytes: Uint8Array): boolean {
  return firstBytes[0] === 0xef && firstBytes[1] === 0xbb && firstBytes[2] === 0xbf;
}

/**
 * by chunk decode single stream, result and whole once decode fully consistent:Node streaming decode in
 * chunk boundary after U+FEFF handle has defect, reason close BOM handle and self row strip stream first mark record.
 */
export class StreamDecoder {
  #decoder = rangeDecoder();
  #started = false;
  decode(bytes?: Uint8Array): string {
    const text = bytes === undefined ? this.#decoder.decode() : this.#decoder.decode(bytes, { stream: true });
    if (this.#started || text === '') return text;
    this.#started = true;
    // U+FEFF only encode is EF BB BF, stream first U+FEFF i.e. byte order mark record.
    return text.startsWith('\ufeff') ? text.slice(1) : text;
  }
}

const NEWLINE = 0x0a;
const lineScanEncoder = new TextEncoder();

const decodedBytes = (text: string): number => (text === '' ? 0 : lineScanEncoder.encode(text).length);

/**
 * by order feed file byte, produce out LineScan: any large small file all can in finite memory in scan.
 * decode byte count and whole decode identical (streaming WHATWG decode).
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
  /** file first token node: accumulate full 3 byte after decide is otherwise BOM. */
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
      // exceeds finally one row choose zone with finally one row end.
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

  /** feed chunk[from, to)(start at file offset base) to still open choose zone decode. */
  #feed(chunk: Uint8Array, base: number, from: number, to: number): void {
    // whole decode will discard file first BOM.
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
