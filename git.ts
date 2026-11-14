// The git object engine: SHA-1 object ids, commit/tree/tag (de)serialisation, packfile reading
// (plain objects plus OFS/REF deltas) and writing (plain objects only — a receiver must accept
// undeltified packs), ancestry and closure arithmetic for upload-pack, and the tree-level diff
// and three-way merge the pull-request surface needs. Everything works on one repository's
// in-memory object map; nothing here knows about HTTP.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** One repository's object database: object id -> object. Objects are immutable once stored. */
export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The object id of a would-be object: sha1 of "<type> <length>\0" followed by the raw bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotently) and answer its id. */
export function storeObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// -------------------------------------------------------------------------------------------------
// Commits, tags and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object body. Unknown headers (gpgsig and friends) are skipped. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit. `author`/`committer` are full identity lines ("Name <email> ts tz"). */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object body. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects until a non-tag object; answers its id (or the input when it is missing). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

export interface TreeEntry {
  /** Raw mode token as stored in the tree: '40000' for a subtree, '100644'/'100755'/'120000' for leaves. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object body: repeated "<mode> <name>\0<20-byte oid>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git orders tree entries by name, with directories compared as if they ended in '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries in git's canonical order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file (leaf) under a tree, as path -> {oid, mode}. Missing trees flatten to nothing. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) the tree hierarchy for a flat path -> blob map; answers the root tree id. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: { name: string; oid: string; mode: string }[];
  }
  const root: Node = { dirs: new Map(), files: [] };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.push({ name: segments[segments.length - 1] ?? path, oid: file.oid, mode: file.mode });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return storeObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

/** The tree of a commit, or null when the commit is unknown. */
export function commitTree(store: ObjectStore, commitOid: string): string | null {
  const commit = store.get(peelToCommit(store, commitOid));
  if (commit === undefined || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

/** Every file under a commit, flattened. */
export function filesOfCommit(store: ObjectStore, commitOid: string): Map<string, { oid: string; mode: string }> {
  const tree = commitTree(store, commitOid);
  return tree === null ? new Map() : flattenTree(store, tree);
}

// -------------------------------------------------------------------------------------------------
// Ancestry and closure

/** All commit ids reachable from `tips` (tags peeled), optionally treating `truncated` commits as parentless. */
export function reachableCommits(store: ObjectStore, tips: readonly string[], truncated?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) queue.push(peelToCommit(store, tip));
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    if (truncated !== undefined && truncated.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (both peeled to commits). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return reachableCommits(store, [descendant]).has(peelToCommit(store, ancestor));
}

/** A best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = reachableCommits(store, [a]);
  const seen = new Set<string>();
  const queue: string[] = [peelToCommit(store, b)];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/**
 * The full object closure of `tips`: every tag, commit, tree, subtree and blob reachable.
 * Commits in `truncated` contribute themselves and their trees but not their parents — the
 * shallow-have rule upload-pack negotiates with.
 */
export function objectClosure(store: ObjectStore, tips: readonly string[], truncated?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const include = (oid: string): void => {
    if (out.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined) return;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) include(entry.oid);
    } else if (object.type === 'tag') {
      include(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      include(parseCommit(object.data).tree);
    }
  };
  for (const tip of tips) include(tip);
  for (const commit of reachableCommits(store, tips, truncated)) include(commit);
  return out;
}

/**
 * The depth-limited closure of `tips` plus the shallow boundary it creates. A commit at
 * distance d from the nearest want is included when d < depth; its tree and blobs come with
 * it. The boundary is the set of included commits that have a parent outside the set — the
 * commits a shallow-info section must name.
 */
export function depthClosure(store: ObjectStore, tips: readonly string[], depth: number): { objects: Set<string>; boundary: Set<string> } {
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(store, tip);
    if (!distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const d = distance.get(oid)!;
    if (d + 1 >= depth) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distance.has(parent)) {
        distance.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const objects = new Set<string>();
  const include = (oid: string): void => {
    if (objects.has(oid)) return;
    const object = store.get(oid);
    if (object === undefined) return;
    objects.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) include(entry.oid);
    } else if (object.type === 'tag') {
      include(parseTag(object.data).object);
    }
  };
  for (const tip of tips) include(tip);
  const boundary = new Set<string>();
  for (const [commit, d] of distance) {
    if (d >= depth) continue;
    const object = store.get(commit);
    if (object === undefined || object.type !== 'commit') continue;
    include(commit);
    const info = parseCommit(object.data);
    include(info.tree);
    if (info.parents.length > 0 && info.parents.some((parent) => !distance.has(parent) || distance.get(parent)! >= depth)) {
      boundary.add(commit);
    }
  }
  return { objects, boundary };
}

// -------------------------------------------------------------------------------------------------
// Packfiles

/** Inflate the zlib stream starting at `offset`; answers its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!Number.isFinite(consumed) || consumed <= 0) throw new Error(`zlib stream at pack offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Read a little-endian base-128 varint (the delta header's size encoding). */
function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buffer[at]!;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarint(delta, 0);
  if (source.value !== base.length) throw new Error(`delta base size ${source.value} does not match the base (${base.length})`);
  const target = readVarint(delta, source.next);
  const out = Buffer.alloc(target.value);
  let at = target.next;
  let written = 0;
  while (at < delta.length) {
    const op = delta[at]!;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at]!; at += 1; }
      if (op & 0x02) { offset |= delta[at]! << 8; at += 1; }
      if (op & 0x04) { offset |= delta[at]! << 16; at += 1; }
      if (op & 0x08) { offset |= delta[at]! << 24; at += 1; }
      if (op & 0x10) { size = delta[at]!; at += 1; }
      if (op & 0x20) { size |= delta[at]! << 8; at += 1; }
      if (op & 0x40) { size |= delta[at]! << 16; at += 1; }
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op > 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} bytes, expected ${target.value}`);
  return out;
}

/**
 * Read a packfile into an object map. Plain entries are inflated directly; OFS_DELTA and
 * REF_DELTA entries are resolved against bases earlier in the pack (or in `external`, the
 * receiving store, for thin packs). Every reconstructed object is hash-verified.
 */
export function readPack(pack: Buffer, external?: ObjectStore): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  let offset = 12;
  const objects = new Map<string, GitObject>();
  const byPackOffset = new Map<number, string>();
  interface RawEntry {
    type: ObjectType;
    data: Buffer;
  }
  const rawByOffset = new Map<number, RawEntry>();
  const resolveOffset = (entryOffset: number): RawEntry => {
    const raw = rawByOffset.get(entryOffset);
    if (raw === undefined) throw new Error(`delta base at pack offset ${entryOffset} was not read`);
    return raw;
  };

  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseType: ObjectType | null = null;
    let baseData: Buffer | null = null;
    if (typeId === 6) {
      // OFS_DELTA: a negative-offset varint back to the base entry.
      let back = pack[offset]!;
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const base = resolveOffset(entryOffset - baseOffset);
      baseType = base.type;
      baseData = base.data;
    } else if (typeId === 7) {
      // REF_DELTA: the base object's id, in this pack or already in the store.
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inPack = objects.get(baseOid);
      const inStore = inPack === undefined && external !== undefined ? external.get(baseOid) : undefined;
      const base = inPack ?? inStore;
      if (base === undefined) throw new Error(`delta base ${baseOid} is not available`);
      baseType = base.type;
      baseData = base.data;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (offset > trailerStart) throw new Error('pack entry overruns the trailer');
    let type: ObjectType;
    let data: Buffer;
    if (baseData !== null && baseType !== null) {
      type = baseType;
      data = applyDelta(baseData, inflated.data);
    } else {
      const plain = ID_TYPES[typeId];
      if (plain === undefined) throw new Error(`pack entry type ${typeId} is not an object type`);
      type = plain;
      data = inflated.data;
      if (data.length !== size) throw new Error(`pack entry declares ${size} bytes but inflated to ${data.length}`);
    }
    const oid = hashObject(type, data);
    objects.set(oid, { type, data });
    byPackOffset.set(entryOffset, oid);
    rawByOffset.set(entryOffset, { type, data });
  }
  void byPackOffset;
  if (objects.size !== declared) throw new Error(`pack declares ${declared} objects but holds ${objects.size} distinct ones`);
  return objects;
}

/** Serialise objects into a version-2 packfile with a SHA-1 trailer. No deltas are produced. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const first = (typeId << 4) | (size & 0x0f);
    const bytes: number[] = [];
    let rest = size >> 4;
    if (rest === 0) {
      bytes.push(first);
    } else {
      bytes.push(first | 0x80);
      while (rest > 0) {
        const byte = rest & 0x7f;
        rest >>= 7;
        bytes.push(rest > 0 ? byte | 0x80 : byte);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------------
// File diffs and three-way tree merges (the pull-request surface)

/** Split text into lines, keeping a trailing partial line. ASCII fixtures make bytes == chars. */
export function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level change counts between two blobs, via a longest-common-subsequence walk. */
export function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    // Pathologically large inputs fall back to whole-file counts rather than an O(n*m) table.
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Uint32Array((a.length + 1) * (b.length + 1));
  const at = (i: number, j: number): number => dp[i * (b.length + 1) + j]!;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * (b.length + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const common = at(0, 0);
  return { additions: b.length - common, deletions: a.length - common };
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

/** The file-level diff between two commits (against their merge base's view of the world). */
export function diffCommits(store: ObjectStore, fromCommit: string | null, toCommit: string): FileChange[] {
  const before = fromCommit === null ? new Map<string, { oid: string; mode: string }>() : filesOfCommit(store, fromCommit);
  const after = filesOfCommit(store, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.oid === newFile.oid) continue;
    if (oldFile === undefined && newFile !== undefined) {
      const blob = store.get(newFile.oid);
      changes.push({ path, status: 'added', additions: blob === undefined ? 0 : splitLines(blob.data).length, deletions: 0 });
    } else if (oldFile !== undefined && newFile === undefined) {
      const blob = store.get(oldFile.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob === undefined ? 0 : splitLines(blob.data).length });
    } else if (oldFile !== undefined && newFile !== undefined) {
      const oldBlob = store.get(oldFile.oid);
      const newBlob = store.get(newFile.oid);
      const counts = lineDiff(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/**
 * A per-file three-way merge of flattened trees. Returns the merged file map, or null with
 * `conflicts` filled when any path changed on both sides in different ways (modify/modify,
 * add/add with different bytes, delete/modify).
 */
export function mergeFileMaps(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): { files: Map<string, { oid: string; mode: string }> } | { conflicts: string[] } {
  const files = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x?: { oid: string; mode: string }, y?: { oid: string; mode: string }): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(o, t)) {
      if (o !== undefined) files.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) files.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length > 0 ? { conflicts } : { files };
}
