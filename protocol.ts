// The git smart-HTTP protocol: pkt-line framing, ref advertisement, upload-pack (protocol v2
// with ls-refs and fetch, plus the v0 fetch the older clients speak) and receive-pack (v0 with
// report-status). The handlers are pure functions of (forge, owner, repo, headers, body) so the
// HTTP shell in app.ts stays thin, and every answer is built from the same in-memory store the
// API surfaces use — a push is visible to REST in the same instant it is reported ok.

import {
  depthClosure,
  isAncestor,
  isOid,
  objectClosure,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './git.ts';
import type { Forge, Repo } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0.0';
const JSON_TYPE = 'application/json';

// -------------------------------------------------------------------------------------------------
// pkt-lines

/** One pkt-line: a 4-hex length prefix (counting itself) over the payload. */
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > 0xffff) throw new Error('pkt-line payload too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Parse every complete pkt-line in `buffer` from `offset`; answers the packets and the end offset. */
export function parsePackets(buffer: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}

/**
 * Parse pkt-lines up to and including the first flush packet; `next` is the offset just past
 * it, where a receive-pack's raw packfile begins (and must not be parsed as pkt-lines).
 */
export function parsePacketsUntilFlush(buffer: Buffer): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = 0;
  for (;;) {
    if (at + 4 > buffer.length) throw new Error('pkt-line stream ends before a flush');
    const header = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, next: at + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
}

/** Wrap pack bytes in sideband band-1 pkt-lines (band 2 progress is never emitted). */
function sideband(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  return chunks;
}

// -------------------------------------------------------------------------------------------------
// Shared helpers

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function lookup(forge: Forge, owner: string, name: string): Repo | null {
  return forge.repo(owner, name);
}

/** All refs in advertisement order: branches then tags, each sorted (lexicographic order does it). */
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The commit an annotated tag points at, for `^{}` peel lines; null for lightweight tags. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo.objects, parseTag(object.data).object);
}

// -------------------------------------------------------------------------------------------------
// Advertisement (GET info/refs)

export function advertise(forge: Forge, owner: string, name: string, service: string, version2: boolean): GitResponse {
  const repo = lookup(forge, owner, name);
  if (repo === null) return jsonError(404, 'Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(403, 'Unsupported service');
  const contentType = `application/x-${service}-advertisement`;
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef) ?? ZERO_OID;

  if (service === 'git-upload-pack' && version2) {
    const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    return { status: 200, contentType, body: Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]) };
  }

  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headRef} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`), FLUSH);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  let first = true;
  const refLine = (oid: string, ref: string): void => {
    if (first) {
      parts.push(pkt(`${oid} ${ref}\0${capabilities}\n`));
      first = false;
    } else {
      parts.push(pkt(`${oid} ${ref}\n`));
    }
  };
  refLine(headOid, 'HEAD');
  for (const [ref, oid] of refs) {
    refLine(oid, ref);
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) parts.push(pkt(`${peeled} ${ref}^{}\n`));
  }
  parts.push(FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

export function lsRefs(repo: Repo, body: Buffer): GitResponse {
  const { packets } = parsePackets(body);
  let section: 'command' | 'args' = 'command';
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 'args';
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 'command') continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headRef}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]),
  };
}

// -------------------------------------------------------------------------------------------------
// Fetch (upload-pack POST)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function fetchComputation(repo: Repo, args: FetchArgs): { send: GitObject[]; boundary: string[]; unshallow: string[]; recognized: string[] } {
  const shallowSet = new Set(args.shallow);
  const haveClosure = args.haves.length === 0 ? new Set<string>() : objectClosure(repo.objects, args.haves, shallowSet);
  let wanted: Set<string>;
  let boundary: string[] = [];
  let unshallow: string[] = [];
  if (args.deepen !== null) {
    const limited = depthClosure(repo.objects, args.wants, args.deepen);
    wanted = limited.objects;
    boundary = [...limited.boundary].sort();
    unshallow = args.shallow.filter((oid) => limited.objects.has(oid) && !limited.boundary.has(oid)).sort();
  } else {
    wanted = objectClosure(repo.objects, args.wants);
  }
  const send: GitObject[] = [];
  for (const oid of wanted) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  const recognized: string[] = [];
  for (const have of args.haves) {
    const commit = peelToCommit(repo.objects, have);
    const object = repo.objects.get(commit);
    if (object !== undefined && object.type === 'commit' && !recognized.includes(commit)) recognized.push(commit);
  }
  return { send, boundary, unshallow, recognized };
}

export function fetchV2(repo: Repo, body: Buffer): GitResponse {
  const { packets } = parsePackets(body);
  let section: 'command' | 'args' = 'command';
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 'args';
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 'command') continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  const computed = fetchComputation(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    // A negotiation round (the client has not said done): acknowledgments only, no packfile.
    // Once `done` was sent, git's upload-pack goes straight to shallow-info / packfile — an
    // acknowledgments section at that point is a protocol error to a real client.
    parts.push(pkt('acknowledgments\n'));
    if (computed.recognized.length === 0) {
      parts.push(pkt('NAK\n'));
    } else {
      for (const oid of computed.recognized) parts.push(pkt(`ACK ${oid}\n`));
    }
    parts.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (args.deepen !== null) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of computed.boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of computed.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  for (const chunk of sideband(writePack(computed.send))) parts.push(chunk);
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function fetchV0(repo: Repo, body: Buffer): GitResponse {
  const { packets } = parsePackets(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let phase: 'wants' | 'haves' = 'wants';
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      if (phase === 'wants') phase = 'haves';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (phase === 'wants') {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
    }
  }
  const computed = fetchComputation(repo, args);
  const parts: Buffer[] = [];
  if (computed.recognized.length === 0) parts.push(pkt('NAK\n'));
  else parts.push(pkt(`ACK ${computed.recognized[computed.recognized.length - 1]}\n`));
  if (args.deepen !== null) {
    for (const oid of computed.boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of computed.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  }
  for (const chunk of sideband(writePack(computed.send))) parts.push(chunk);
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** Dispatch an upload-pack POST: a v2 command request or a v0 want/have negotiation. */
export function uploadPack(repo: Repo, body: Buffer): GitResponse {
  const { packets } = parsePackets(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';
  if (firstLine.startsWith('command=ls-refs')) return lsRefs(repo, body);
  if (firstLine.startsWith('command=fetch')) return fetchV2(repo, body);
  return fetchV0(repo, body);
}

// -------------------------------------------------------------------------------------------------
// Push (receive-pack POST)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): GitResponse {
  const { packets, next } = parsePacketsUntilFlush(body);
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = new Set(line.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length === 3 && isOid(fields[0]!) && isOid(fields[1]!)) {
      commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
    }
  }
  const pack = sawFlush ? body.subarray(next) : Buffer.alloc(0);

  let unpackLine = 'unpack ok\n';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, repo.objects);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'pack parse failed'}\n`;
    }
  }

  const reportLines: string[] = [unpackLine];
  const unpackOk = unpackLine === 'unpack ok\n';
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== ZERO_OID && current !== command.newOid) {
      const currentCommit = peelToCommit(repo.objects, current);
      const newCommit = peelToCommit(repo.objects, command.newOid);
      const currentObject = repo.objects.get(currentCommit);
      const newObject = repo.objects.get(newCommit);
      const fastForward =
        currentObject !== undefined && newObject !== undefined && currentObject.type === 'commit' && newObject.type === 'commit'
          ? isAncestor(repo.objects, currentCommit, newCommit)
          : false;
      if (!fastForward) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  let responseBody: Buffer;
  if (capabilities.has('side-band-64k')) {
    const inner = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < inner.length; at += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), inner.subarray(at, at + CHUNK)])));
    }
    parts.push(FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Dispatch a git POST by service. */
export function gitPost(forge: Forge, owner: string, name: string, service: string, body: Buffer): GitResponse {
  const repo = lookup(forge, owner, name);
  if (repo === null) return jsonError(404, 'Not Found');
  if (service === 'git-upload-pack') return uploadPack(repo, body);
  if (service === 'git-receive-pack') return receivePack(repo, body);
  return jsonError(403, 'Unsupported service');
}
