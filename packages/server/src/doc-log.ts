/**
 * The framed log file that holds a doc's updates since its snapshot. Each
 * record is [u32 length][u32 crc32 of the bytes][bytes], both numbers
 * little-endian. A record whose length or checksum is wrong, or whose bytes
 * the caller does not accept, ends the log: the reader moves it and
 * everything after it to `log.corrupt-<time>` beside the log and truncates
 * the log to the last good record, so later appends follow valid data. No
 * attempt is made to find good records past a bad one; a length field cannot
 * be trusted once one record is wrong.
 */
import { randomBytes } from 'node:crypto';
import { open, readFile, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

const HEADER_BYTES = 8;

export function encodeRecord(payload: Uint8Array): Uint8Array {
  if (payload.length === 0) throw new Error('A log record cannot be empty');
  const record = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, crc32(payload), true);
  record.set(payload, HEADER_BYTES);
  return record;
}

/**
 * Splits log bytes into records. `validLength` is the byte length of the good
 * records; anything past it is a torn or corrupt tail. A zero length is
 * invalid, so a zero-filled tail left by a crash is not read as records.
 */
export function parseLog(
  bytes: Uint8Array,
  accept: (payload: Uint8Array) => boolean = () => true,
): { records: Uint8Array[]; validLength: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Uint8Array[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= bytes.length) {
    const length = view.getUint32(offset, true);
    const checksum = view.getUint32(offset + 4, true);
    const start = offset + HEADER_BYTES;
    if (length === 0 || start + length > bytes.length) break;
    const payload = bytes.subarray(start, start + length);
    if (crc32(payload) !== checksum || !accept(payload)) break;
    records.push(payload);
    offset = start + length;
  }
  return { records, validLength: offset };
}

/**
 * Reads every good record, setting a torn or corrupt tail aside and
 * truncating the file to the good records. A missing file has no records.
 * `length` is the file's byte length afterwards.
 */
export async function readLog(
  path: string,
  accept?: (payload: Uint8Array) => boolean,
): Promise<{ records: Uint8Array[]; length: number }> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return { records: [], length: 0 };
    throw error;
  }
  const { records, validLength } = parseLog(bytes, accept);
  if (validLength < bytes.length) {
    const aside = `${path}.corrupt-${timestamp()}`;
    await writeFile(aside, bytes.subarray(validLength));
    console.warn(
      `Moved ${bytes.length - validLength} bytes of torn or corrupt records at the end of ${path} to ${aside}; ` +
        'the next handshake restores whatever they held',
    );
    await truncate(path, validLength);
  }
  return { records, length: validLength };
}

/** Appends one record, waits for it to reach the disk, and resolves to the bytes added. */
export async function appendRecord(path: string, payload: Uint8Array): Promise<number> {
  const record = encodeRecord(payload);
  const file = await open(path, 'a');
  try {
    await writeAll(file, record);
    await file.datasync();
  } finally {
    await file.close();
  }
  return record.length;
}

/** Writes every byte, continuing after a short write. Throws when the file accepts no bytes at all. */
export async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes.subarray(offset));
    if (bytesWritten === 0) throw new Error(`Writing stopped after ${offset} of ${bytes.length} bytes`);
    offset += bytesWritten;
  }
}

/** A file-name-safe time stamp, unique enough for files set aside. */
export function timestamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
