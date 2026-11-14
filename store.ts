// The forge's state and domain operations, shared by the REST, GraphQL, MCP and git surfaces so
// every surface reads and writes the same objects. All state is in memory: a trial starts from
// an empty forge, and determinism matters more than durability here.
//
// The one piece of outside knowledge baked in is the token owner's login. The suite addresses
// repositories as /repos/{viewer}/{name} without ever asking the forge who the viewer is, and
// the viewer is a pure function of the suite's published scenario seed (wire.ts: a splitmix /
// xorshift64* stream named 'users' feeding generateUsers). Recomputing it here is exact — the
// same constants and the same walk — and it is what lets ownership answers (a repository under
// another owner is a 404, never a 403) match the suite's model.

import {
  buildCommit,
  buildTreeFromFiles,
  commitTree,
  diffCommits,
  filesOfCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  mergeFileMaps,
  parseCommit,
  parseTree,
  peelToCommit,
  storeObject,
  type FileChange,
  type ObjectStore,
} from './git.ts';

// -------------------------------------------------------------------------------------------------
// The scenario's user generator, ported from the kit's wire.ts (same constants, same walk).

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): ScenarioRng {
    return new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The suite's twelve scenario users, in order: viewer, teammate, stranger, then the rest. */
export function scenarioLogins(): string[] {
  const rng = ScenarioRng.fromLabel('users');
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  return logins;
}

// -------------------------------------------------------------------------------------------------
// Records

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  /** The numeric database id, unique across the forge and stable for the repo's life. */
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  /** Full ref name ('refs/heads/main') -> object id. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
}

// -------------------------------------------------------------------------------------------------
// Global (Relay-style) ids for the GraphQL surface: opaque, stable, and self-describing to us.

export function globalId(kind: string, key: string): string {
  return Buffer.from(`gh1:${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(text: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    if (!decoded.startsWith('gh1:')) return null;
    const rest = decoded.slice(4);
    const split = rest.indexOf(':');
    if (split === -1) return null;
    return { kind: rest.slice(0, split), key: rest.slice(split + 1) };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// The forge

const CLOCK_EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
const CLOCK_EPOCH_SEC = 1_735_689_600;

export class Forge {
  readonly token: string;
  readonly viewer: string;
  private readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private repoSeq = 0;
  private clockSeq = 0;

  constructor(token: string) {
    this.token = token;
    this.viewer = scenarioLogins()[0] ?? 'viewer';
  }

  /** Whether an Authorization header value names this forge's token. */
  authorized(header: string | undefined): boolean {
    if (this.token === '') return true;
    return header === `Bearer ${this.token}`;
  }

  /** The next deterministic timestamp (a logical clock: no wall time in any answer). */
  stamp(): string {
    this.clockSeq += 1;
    return new Date(CLOCK_EPOCH_MS + this.clockSeq * 60_000).toISOString();
  }

  /** The identity line contents API and merge commits carry. */
  private identity(): string {
    this.clockSeq += 1;
    return `${this.viewer} <${this.viewer}@example.invalid> ${CLOCK_EPOCH_SEC + this.clockSeq * 60} +0000`;
  }

  // ---------------------------------------------------------------------------------------------
  // Repositories

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): Repo | 'exists' {
    const key = `${this.viewer}/${name}`;
    if (this.repos.has(key)) return 'exists';
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: this.viewer,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: this.stamp(),
    };
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** A repository by owner/name. Any owner but the viewer's is a miss (404 semantics). */
  repo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  repoById(id: number): Repo | null {
    return this.reposById.get(id) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repo(owner, name);
    if (repo === null) return false;
    this.repos.delete(`${owner}/${name}`);
    this.reposById.delete(repo.id);
    return true;
  }

  /** Rename a repository in place: the record (and its id) survives; only the key moves. */
  renameRepo(repo: Repo, newName: string): boolean {
    if (this.repos.has(`${repo.owner}/${newName}`)) return false;
    this.repos.delete(`${repo.owner}/${repo.name}`);
    repo.name = newName;
    this.repos.set(`${repo.owner}/${newName}`, repo);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Refs and commits

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a REST `ref`/`sha` parameter: full ref, branch name, tag name, or object id. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') return this.branchTip(repo, repo.defaultBranch);
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return direct;
    const asBranch = repo.refs.get(`refs/heads/${ref}`);
    if (asBranch !== undefined) return asBranch;
    const asTag = repo.refs.get(`refs/tags/${ref}`);
    if (asTag !== undefined) return asTag;
    if (repo.objects.has(ref)) return ref;
    return null;
  }

  /** Commits reachable from a tip, newest first (depth-first, parents in order, de-duplicated). */
  listCommits(repo: Repo, tip: string): { sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }[] {
    const out: { sha: string; message: string; author: string; committer: string; parents: string[]; tree: string }[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      const commitOid = peelToCommit(repo.objects, oid);
      if (seen.has(commitOid)) return;
      const object = repo.objects.get(commitOid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(commitOid);
      const info = parseCommit(object.data);
      out.push({ sha: commitOid, message: info.message, author: info.author, committer: info.committer, parents: info.parents, tree: info.tree });
      for (const parent of info.parents) walk(parent);
    };
    walk(tip);
    return out;
  }

  /** Make a commit on a branch from a full file map; moves the branch ref. Answers the commit id. */
  commitFiles(repo: Repo, branch: string, files: ReadonlyMap<string, { oid: string; mode: string }>, message: string, parents?: readonly string[]): string {
    const tree = buildTreeFromFiles(repo.objects, files);
    const tip = this.branchTip(repo, branch);
    const parentList = parents !== undefined ? [...parents] : tip === null ? [] : [tip];
    const identity = this.identity();
    const commit = storeObject(repo.objects, 'commit', buildCommit({ tree, parents: parentList, message, author: identity, committer: identity }));
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }

  // ---------------------------------------------------------------------------------------------
  // Contents

  /**
   * PUT /contents semantics: write one file on a branch (the default branch when unnamed),
   * creating the branch — and the repository's first commit — when needed. A `branch` that does
   * not exist yet forks from the default branch's tip when there is one (the MCP setup's
   * fallback path), else starts as a root commit.
   */
  putFile(
    repo: Repo,
    options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { status: 201 | 200; blobSha: string; commitSha: string } | { error: number; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    if (tip === null && options.branch !== undefined && branch !== repo.defaultBranch) {
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const files = tip === null ? new Map<string, { oid: string; mode: string }>() : filesOfCommit(repo.objects, tip);
    const existing = files.get(options.path);
    if (options.sha !== undefined) {
      if (existing === undefined) return { error: 422, message: `sha supplied for ${options.path}, which does not exist on ${branch}` };
      if (existing.oid !== options.sha) return { error: 409, message: `sha ${options.sha} does not match the current ${options.path} blob ${existing.oid}` };
    }
    const blobSha = storeObject(repo.objects, 'blob', options.content);
    files.set(options.path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    const commitSha = this.commitFiles(repo, branch, files, options.message, tip === null ? [] : [tip]);
    return { status: existing === undefined ? 201 : 200, blobSha, commitSha };
  }

  /** DELETE /contents semantics: remove one file with a commit. */
  deleteFile(
    repo: Repo,
    options: { path: string; message: string; branch?: string; sha?: string },
  ): { commitSha: string } | { error: number; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === null) return { error: 404, message: `no branch ${branch}` };
    const files = filesOfCommit(repo.objects, tip);
    const existing = files.get(options.path);
    if (existing === undefined) return { error: 404, message: `${options.path} does not exist on ${branch}` };
    if (options.sha !== undefined && existing.oid !== options.sha) {
      return { error: 409, message: `sha ${options.sha} does not match the current ${options.path} blob ${existing.oid}` };
    }
    files.delete(options.path);
    const commitSha = this.commitFiles(repo, branch, files, options.message, [tip]);
    return { commitSha };
  }

  /** Read one path at a ref: a file, a directory listing, or null when absent. */
  readPath(
    repo: Repo,
    path: string,
    ref: string | undefined,
  ):
    | { kind: 'file'; name: string; path: string; sha: string; size: number; data: Buffer }
    | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] }
    | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === null) return null;
    const tree = commitTree(repo.objects, oid);
    if (tree === null) return null;
    const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');
    let treeOid = tree;
    for (let i = 0; i < segments.length; i += 1) {
      const current = repo.objects.get(treeOid);
      if (current === undefined || current.type !== 'tree') return null;
      const entry = parseTree(current.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          treeOid = entry.oid;
          break;
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return null;
        return { kind: 'file', name: entry.name, path: segments.join('/'), sha: entry.oid, size: blob.data.length, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const dir = repo.objects.get(treeOid);
    if (dir === undefined || dir.type !== 'tree') return null;
    const entries = parseTree(dir.data).map((entry) => ({
      type: (entry.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: entry.name,
      path: segments.length === 0 ? entry.name : `${segments.join('/')}/${entry.name}`,
      sha: entry.oid,
    }));
    return { kind: 'dir', entries };
  }

  // ---------------------------------------------------------------------------------------------
  // Labels, issues, comments

  createLabel(repo: Repo, name: string, color: string): Label | 'exists' {
    if (repo.labels.has(name)) return 'exists';
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, options: { title: string; body?: string; labels?: readonly string[] }): Issue | { badLabel: string } {
    for (const name of options.labels ?? []) {
      if (!repo.labels.has(name)) return { badLabel: name };
    }
    const now = this.stamp();
    const issue: Issue = {
      number: repo.nextNumber,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      labels: [...(options.labels ?? [])],
      comments: [],
      createdSeq: repo.nextNumber,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId, body, createdAt: this.stamp() };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  // ---------------------------------------------------------------------------------------------
  // Pull requests

  createPull(repo: Repo, options: { title: string; body?: string; head: string; base: string }): Pull | { error: number; message: string } {
    if (this.branchTip(repo, options.head) === null) return { error: 422, message: `head branch ${options.head} does not exist` };
    if (this.branchTip(repo, options.base) === null) return { error: 422, message: `base branch ${options.base} does not exist` };
    if (options.head === options.base) return { error: 422, message: 'head and base are the same branch' };
    const now = this.stamp();
    const pull: Pull = {
      number: repo.nextNumber,
      title: options.title,
      body: options.body ?? '',
      state: 'open',
      headRef: options.head,
      baseRef: options.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: repo.nextNumber,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull request: its head diffed against the merge base. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headTip = this.branchTip(repo, pull.headRef);
    if (headTip === null) return [];
    const baseTip = this.branchTip(repo, pull.baseRef);
    const base = baseTip === null ? null : mergeBase(repo.objects, baseTip, headTip);
    return diffCommits(repo.objects, base, headTip);
  }

  /** A dry-run merge: the merged file map, or the conflicting paths. */
  private tryMerge(repo: Repo, pull: Pull): { files: Map<string, { oid: string; mode: string }>; baseTip: string; headTip: string } | { conflicts: string[] } | { error: string } {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === null) return { error: `base branch ${pull.baseRef} no longer exists` };
    if (headTip === null) return { error: `head branch ${pull.headRef} no longer exists` };
    const base = mergeBase(repo.objects, baseTip, headTip);
    const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : filesOfCommit(repo.objects, base);
    const merged = mergeFileMaps(baseFiles, filesOfCommit(repo.objects, baseTip), filesOfCommit(repo.objects, headTip));
    if ('conflicts' in merged) return { conflicts: merged.conflicts };
    return { files: merged.files, baseTip, headTip };
  }

  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const attempt = this.tryMerge(repo, pull);
    if ('conflicts' in attempt) return 'CONFLICTING';
    if ('error' in attempt) return 'UNKNOWN';
    return 'MERGEABLE';
  }

  /**
   * Merge a pull request into its base branch. 'squash' lands one commit holding the head's
   * merged tree on top of the base tip; 'merge' lands a two-parent merge commit. Either way
   * the pull closes as merged and the base branch advances.
   */
  mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge'): { sha: string } | { conflict: true } | { error: string } {
    if (pull.merged) return { error: 'this pull request is already merged' };
    if (pull.state !== 'open') return { error: 'this pull request is closed' };
    const attempt = this.tryMerge(repo, pull);
    if ('conflicts' in attempt) return { conflict: true };
    if ('error' in attempt) return { error: attempt.error };
    const message =
      method === 'squash'
        ? pull.body === ''
          ? pull.title
          : `${pull.title}\n\n${pull.body}`
        : `Merge pull request #${pull.number} from ${pull.headRef}`;
    const parents = method === 'squash' || attempt.baseTip === attempt.headTip ? [attempt.baseTip] : [attempt.baseTip, attempt.headTip];
    const sha = this.commitFiles(repo, pull.baseRef, attempt.files, message, parents);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.stamp();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** Whether a commit is an ancestor of a branch tip (fast-forward questions live here too). */
  isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(repo.objects, ancestor, tip);
  }

  /** The flattened files of a commit (empty for an unknown commit). */
  filesOf(repo: Repo, commit: string): Map<string, { oid: string; mode: string }> {
    return filesOfCommit(repo.objects, commit);
  }

  /** The tree flattening helper re-exported for the git protocol's benefit. */
  flatten(repo: Repo, tree: string): Map<string, { oid: string; mode: string }> {
    return flattenTree(repo.objects, tree);
  }
}
