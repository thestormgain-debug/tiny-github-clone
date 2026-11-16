// Git object/pack plumbing for the forge: pkt-lines, loose objects, tree/commit/tag
// encoding and parsing, packfile reading and writing. Pure functions over Buffers.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse a byte stream into pkt-lines. Tolerates trailing partial bytes (ignored). */
export function parsePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------- trees, commits, tags

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSort(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeSort);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const lines = header.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: Buffer.from(data) };
}

export function buildCommit(options: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${options.timestamp} +0000`;
  const lines = [`tree ${options.tree}`];
  for (const parent of options.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${options.author} ${stamp}`);
  lines.push(`committer ${options.committer} ${stamp}`);
  return Buffer.from(`${lines.join('\n')}\n\n${options.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(options: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const stamp = `${options.timestamp} +0000`;
  return Buffer.from(
    `object ${options.object}\ntype ${options.type}\ntag ${options.tag}\ntagger ${options.tagger} ${stamp}\n\n${options.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- pack writing

function typeNumber(type: ObjType): number {
  return type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
}

function objHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (typeNumber(type) << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** Write a packfile (version 2) holding the given objects, in the given order. */
export function writePack(objects: ReadonlyArray<{ type: ObjType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK', 'ascii'), Buffer.alloc(4)];
  chunks[1].writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  chunks.push(count);
  for (const object of objects) {
    chunks.push(objHeader(object.type, object.data.length));
    chunks.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack reading

export interface PackObject {
  type: ObjType;
  data: Buffer;
}

function sizeFromVarint(buf: Buffer, offset: number): { size: number; shift: number; consumed: number } {
  let size = buf[offset] & 0x0f;
  let shift = 4;
  let consumed = 1;
  let current = buf[offset];
  while (current & 0x80) {
    current = buf[offset + consumed];
    size |= (current & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return { size, shift, consumed };
}

function typeByteType(value: number): ObjType {
  if (value === 1) return 'commit';
  if (value === 2) return 'tree';
  if (value === 3) return 'blob';
  if (value === 4) return 'tag';
  throw new Error(`bad pack object type ${value}`);
}

/** Read a packfile's objects, resolving ofs/ref deltas. Answers oid -> object. */
export function readPack(pack: Buffer): { objects: Map<string, PackObject>; declaredCount: number; entries: unknown[]; deltaCount: number } {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic missing');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const entries: { oid: string; offset: number }[] = [];
  const byOffset = new Map<number, { type: ObjType | 'ofs_delta' | 'ref_delta'; data: Buffer; baseOffset?: number; baseOid?: string; inflated?: Buffer }>();
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    let current = pack[offset];
    const typeValue = (current >> 4) & 0x07;
    const { consumed } = sizeFromVarint(pack, offset);
    offset += consumed;
    if (typeValue === 6) {
      let ofs = 0;
      let currentByte = pack[offset];
      ofs = currentByte & 0x7f;
      let consumedOfs = 1;
      while (currentByte & 0x80) {
        currentByte = pack[offset + consumedOfs];
        ofs = ((ofs + 1) << 7) | (currentByte & 0x7f);
        consumedOfs += 1;
      }
      offset += consumedOfs;
      const inflated = inflateWithSize(pack.subarray(offset));
      byOffset.set(entryOffset, { type: 'ofs_delta', data: Buffer.alloc(0), baseOffset: entryOffset - ofs, inflated: inflated.data });
      offset += inflated.consumed;
      deltaCount += 1;
    } else if (typeValue === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateWithSize(pack.subarray(offset));
      byOffset.set(entryOffset, { type: 'ref_delta', data: Buffer.alloc(0), baseOid, inflated: inflated.data });
      offset += inflated.consumed;
      deltaCount += 1;
    } else {
      const type = typeByteType(typeValue);
      const inflated = inflateWithSize(pack.subarray(offset));
      byOffset.set(entryOffset, { type, data: inflated.data });
      offset += inflated.consumed;
    }
    entries.push({ oid: '', offset: entryOffset });
  }
  // Resolve objects by offset; deltas may chain.
  const resolvedByOffset = new Map<number, PackObject>();
  const resolveOffset = (entryOffset: number, seen: Set<number>): PackObject => {
    const cached = resolvedByOffset.get(entryOffset);
    if (cached) return cached;
    if (seen.has(entryOffset)) throw new Error('delta cycle in pack');
    seen.add(entryOffset);
    const entry = byOffset.get(entryOffset);
    if (!entry) throw new Error('pack entry missing');
    if (entry.type === 'ofs_delta' || entry.type === 'ref_delta') {
      const base = entry.type === 'ofs_delta'
        ? resolveOffset(entry.baseOffset!, seen)
        : resolveByOid(entry.baseOid!, seen);
      const deltaData = applyDelta(base.data, inflateOne(entry.inflated!));
      const object: PackObject = { type: base.type, data: deltaData };
      resolvedByOffset.set(entryOffset, object);
      return object;
    }
    const object: PackObject = { type: entry.type, data: entry.data };
    resolvedByOffset.set(entryOffset, object);
    return object;
  };
  const byOid = new Map<string, PackObject>();
  const resolveByOid = (oid: string, seen: Set<number>): PackObject => {
    const known = byOid.get(oid);
    if (known) return known;
    for (const [entryOffset, entry] of byOffset) {
      if (entry.type === 'ofs_delta' || entry.type === 'ref_delta') continue;
      const object = resolveOffset(entryOffset, seen);
      const computed = hashObject(object.type, object.data);
      byOid.set(computed, object);
      if (computed === oid) return object;
    }
    throw new Error(`pack base ${oid} missing`);
  };
  const objects = new Map<string, PackObject>();
  for (const entry of entries) {
    const object = resolveOffset(entry.offset, new Set());
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
    byOid.set(oid, object);
    entry.oid = oid;
  }
  return { objects, declaredCount, entries, deltaCount };
}

/** Inflate one zlib stream starting at `offset`, answering the inflated bytes. */
function inflateOne(compressed: Buffer): Buffer {
  return inflateWithSize(compressed).data;
}

/** The inflated bytes of the first zlib stream in `compressed`. */
function inflateWithSize(compressed: Buffer): { data: Buffer; consumed: number } {
  // Node's inflateSync ignores trailing bytes and throws "unexpected end of file" on a truncated
  // stream, so the stream's end is the SMALLEST prefix that inflates: binary search for it.
  let lo = 8;
  let hi = compressed.length;
  let data = Buffer.alloc(0);
  let consumed = compressed.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(compressed.subarray(0, mid));
      consumed = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed };
}

export { inflateWithSize };

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const instruction = delta[offset++];
    if (instruction & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (instruction & 0x01) copyOffset |= delta[offset++];
      if (instruction & 0x02) copyOffset |= delta[offset++] << 8;
      if (instruction & 0x04) copyOffset |= delta[offset++] << 16;
      if (instruction & 0x08) copyOffset |= delta[offset++] << 24;
      if (instruction & 0x10) copySize |= delta[offset++];
      if (instruction & 0x20) copySize |= delta[offset++] << 8;
      if (instruction & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (instruction > 0) {
      parts.push(delta.subarray(offset, offset + instruction));
      produced += instruction;
      offset += instruction;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== resultSize || out.length !== resultSize) throw new Error(`delta result size ${out.length} != ${resultSize}`);
  return out;
}

export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: expected === actual, expected, actual };
}
