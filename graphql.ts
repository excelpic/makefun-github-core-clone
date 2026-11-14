// The GraphQL v4 surface: a small but real GraphQL implementation — tokenizer, parser
// (operations, variables, aliases, inline fragments, input objects, enum literals, batching),
// a GitHub-shaped schema over the shared Forge store, and the introspection answers gh's
// feature probes read. The documents the suite sends are gh's and github-mcp-server's own, so
// the schema covers exactly the fields those clients use, with GitHub's semantics: a field the
// schema does not hold is a 200 with an `errors` array, an unknown repository is
// `data.repository = null` with no errors, and global ids are opaque and stable.

import { globalId, parseGlobalId, type Forge, type Issue, type Pull, type Repo } from './store.ts';

// -------------------------------------------------------------------------------------------------
// Tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else throw new Error(`bad string escape \\${esc}`);
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let kind: 'int' | 'float' = 'int';
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        if (source[j] === '.') {
          j += 1;
          while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
        }
        if (source[j] === 'e' || source[j] === 'E') {
          j += 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
        }
      }
      tokens.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------------
// Parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition?: string; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition?: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at]!;
  }

  private next(): Token {
    const token = this.tokens[this.at]!;
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition?: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const onKeyword = this.expectName();
        if (onKeyword !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }
}

function parse(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

// -------------------------------------------------------------------------------------------------
// Values

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// -------------------------------------------------------------------------------------------------
// Schema: sources are tagged wrappers over store records.

interface Src {
  __type: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  commentId?: number;
  name?: string;
  nodes?: Src[];
  pageInfo?: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount?: number;
  typeName?: string;
  fieldName?: string;
}

const userSrc = (): Src => ({ __type: 'User' });
const repoSrc = (repo: Repo): Src => ({ __type: 'Repository', repo });
const issueSrc = (repo: Repo, issue: Issue): Src => ({ __type: 'Issue', repo, issue });
const pullSrc = (repo: Repo, pull: Pull): Src => ({ __type: 'PullRequest', repo, pull });

class GqlError extends Error {}

type Resolver = (forge: Forge, src: Src, args: Record<string, unknown>) => unknown;

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const value = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function findIssueByGid(forge: Forge, gid: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof gid !== 'string') return null;
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  const repo = repoId === undefined ? null : forge.repoById(repoId);
  const issue = repo?.issues.get(number ?? -1);
  return repo !== null && repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function findPullByGid(forge: Forge, gid: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof gid !== 'string') return null;
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  const repo = repoId === undefined ? null : forge.repoById(repoId);
  const pull = repo?.pulls.get(number ?? -1);
  return repo !== null && repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

function repoByGid(forge: Forge, gid: unknown): Repo | null {
  if (typeof gid !== 'string') return null;
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return forge.repoById(Number.parseInt(parsed.key, 10));
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSrc(),
    repository: (forge, _src, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = forge.repo(args.owner, args.name);
      return repo === null ? null : repoSrc(repo);
    },
    node: (forge, _src, args) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = forge.repoById(Number.parseInt(parsed.key, 10));
        return repo === null ? null : repoSrc(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = findIssueByGid(forge, args.id);
        return found === null ? null : issueSrc(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = findPullByGid(forge, args.id);
        return found === null ? null : pullSrc(found.repo, found.pull);
      }
      return null;
    },
    __type: (_forge, _src, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      return typeKnown(name) ? { __type: '__Type', typeName: name } : null;
    },
  },
  Mutation: {
    createIssue: (forge, _src, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByGid(forge, input.repositoryId);
      if (repo === null) throw new GqlError('repository not found for createIssue');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const created = forge.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      if ('badLabel' in created) throw new GqlError(`label '${created.badLabel}' does not exist`);
      return { __type: 'CreateIssuePayload', nodes: [issueSrc(repo, created)] };
    },
    closeIssue: (forge, _src, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGid(forge, input.issueId);
      if (found === null) throw new GqlError('issue not found for closeIssue');
      found.issue.state = 'closed';
      found.issue.updatedAt = forge.stamp();
      return { __type: 'CloseIssuePayload', nodes: [issueSrc(found.repo, found.issue)] };
    },
    createPullRequest: (forge, _src, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoByGid(forge, input.repositoryId);
      if (repo === null) throw new GqlError('repository not found for createPullRequest');
      const created = forge.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if ('error' in created) throw new GqlError(created.message);
      return { __type: 'CreatePullRequestPayload', nodes: [pullSrc(repo, created)] };
    },
    mergePullRequest: (forge, _src, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findPullByGid(forge, input.pullRequestId);
      if (found === null) throw new GqlError('pull request not found for mergePullRequest');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'MERGE';
      const result = forge.mergePull(found.repo, found.pull, method === 'SQUASH' ? 'squash' : 'merge');
      if ('conflict' in result) throw new GqlError('pull request is not mergeable');
      if ('error' in result) throw new GqlError(result.error);
      return { __type: 'MergePullRequestPayload', nodes: [pullSrc(found.repo, found.pull)] };
    },
    addComment: (forge, _src, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGid(forge, input.subjectId);
      if (found === null) throw new GqlError('subject not found for addComment');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = forge.addComment(found.repo, found.issue, body);
      const node: Src = { __type: 'IssueComment', repo: found.repo, issue: found.issue, commentId: comment.id, name: body };
      return { __type: 'AddCommentPayload', nodes: [node] };
    },
  },
  User: {
    login: (forge) => forge.viewer,
    id: (forge) => globalId('User', forge.viewer),
    name: (forge) => forge.viewer,
  },
  Repository: {
    id: (_forge, src) => globalId('Repository', String(src.repo!.id)),
    databaseId: (_forge, src) => src.repo!.id,
    name: (_forge, src) => src.repo!.name,
    nameWithOwner: (_forge, src) => `${src.repo!.owner}/${src.repo!.name}`,
    owner: () => userSrc(),
    defaultBranchRef: (_forge, src) => {
      const repo = src.repo!;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (_forge, src) => src.repo!.isPrivate,
    description: (_forge, src) => src.repo!.description,
    createdAt: (_forge, src) => src.repo!.createdAt,
    updatedAt: (_forge, src) => src.repo!.createdAt,
    issue: (_forge, src, args) => {
      const issue = src.repo!.issues.get(typeof args.number === 'number' ? args.number : -1);
      return issue === undefined ? null : issueSrc(src.repo!, issue);
    },
    issues: (_forge, src, args) => {
      const repo = src.repo!;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? args.states.filter((state): state is string => typeof state === 'string') : [];
      if (states.length > 0) list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const descending = orderBy.direction === 'DESC';
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const totalCount = list.length;
      let start = 0;
      const after = numberFromCursor(args.after);
      if (after !== null) {
        const index = list.findIndex((issue) => issue.number === after);
        if (index !== -1) start = index + 1;
      }
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : 30;
      const page = list.slice(start, start + first);
      return {
        __type: 'IssueConnection',
        nodes: page.map((issue) => issueSrc(repo, issue)),
        totalCount,
        pageInfo: {
          hasNextPage: start + page.length < totalCount,
          hasPreviousPage: start > 0,
          startCursor: page.length > 0 ? cursorOf(page[0]!.number) : null,
          endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
        },
      };
    },
    pullRequest: (_forge, src, args) => {
      const pull = src.repo!.pulls.get(typeof args.number === 'number' ? args.number : -1);
      return pull === undefined ? null : pullSrc(src.repo!, pull);
    },
    pullRequests: (_forge, src, args) => {
      const repo = src.repo!;
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const states = Array.isArray(args.states) ? args.states.filter((state): state is string => typeof state === 'string') : [];
      const filtered = states.length > 0
        ? list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()))
        : list;
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : 30;
      const page = filtered.slice(0, first);
      return {
        __type: 'PullRequestConnection',
        nodes: page.map((pull) => pullSrc(repo, pull)),
        totalCount: filtered.length,
        pageInfo: {
          hasNextPage: page.length < filtered.length,
          hasPreviousPage: false,
          startCursor: page.length > 0 ? cursorOf(page[0]!.number) : null,
          endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
        },
      };
    },
  },
  Ref: {
    name: (_forge, src) => src.name ?? '',
  },
  Issue: {
    id: (_forge, src) => globalId('Issue', `${src.repo!.id}:${src.issue!.number}`),
    number: (_forge, src) => src.issue!.number,
    title: (_forge, src) => src.issue!.title,
    state: (_forge, src) => src.issue!.state.toUpperCase(),
    body: (_forge, src) => src.issue!.body,
    createdAt: (_forge, src) => src.issue!.createdAt,
    updatedAt: (_forge, src) => src.issue!.updatedAt,
    author: () => userSrc(),
    repository: (_forge, src) => repoSrc(src.repo!),
  },
  IssueConnection: {
    nodes: (_forge, src) => src.nodes ?? [],
    totalCount: (_forge, src) => src.totalCount ?? 0,
    pageInfo: (_forge, src) => ({ __type: 'PageInfo', pageInfo: src.pageInfo }),
  },
  PullRequestConnection: {
    nodes: (_forge, src) => src.nodes ?? [],
    totalCount: (_forge, src) => src.totalCount ?? 0,
    pageInfo: (_forge, src) => ({ __type: 'PageInfo', pageInfo: src.pageInfo }),
  },
  PageInfo: {
    hasNextPage: (_forge, src) => src.pageInfo?.hasNextPage ?? false,
    hasPreviousPage: (_forge, src) => src.pageInfo?.hasPreviousPage ?? false,
    startCursor: (_forge, src) => src.pageInfo?.startCursor ?? null,
    endCursor: (_forge, src) => src.pageInfo?.endCursor ?? null,
  },
  PullRequest: {
    id: (_forge, src) => globalId('PullRequest', `${src.repo!.id}:${src.pull!.number}`),
    number: (_forge, src) => src.pull!.number,
    title: (_forge, src) => src.pull!.title,
    body: (_forge, src) => src.pull!.body,
    state: (_forge, src) => (src.pull!.merged ? 'MERGED' : src.pull!.state.toUpperCase()),
    merged: (_forge, src) => src.pull!.merged,
    mergeable: (forge, src) => forge.pullMergeable(src.repo!, src.pull!),
    headRefName: (_forge, src) => src.pull!.headRef,
    baseRefName: (_forge, src) => src.pull!.baseRef,
    createdAt: (_forge, src) => src.pull!.createdAt,
    updatedAt: (_forge, src) => src.pull!.updatedAt,
    author: () => userSrc(),
    repository: (_forge, src) => repoSrc(src.repo!),
    files: (forge, src, args) => {
      const changes = forge.pullFiles(src.repo!, src.pull!);
      const first = typeof args.first === 'number' && args.first >= 0 ? args.first : 30;
      return {
        __type: 'PullRequestChangedFileConnection',
        totalCount: changes.length,
        nodes: changes.slice(0, first).map((change) => ({
          __type: 'PullRequestChangedFile',
          name: change.path,
          totalCount: change.additions,
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          commentId: change.deletions,
          typeName: change.status,
        })),
      };
    },
  },
  PullRequestChangedFileConnection: {
    nodes: (_forge, src) => src.nodes ?? [],
    totalCount: (_forge, src) => src.totalCount ?? 0,
  },
  PullRequestChangedFile: {
    path: (_forge, src) => src.name ?? '',
    additions: (_forge, src) => src.totalCount ?? 0,
    deletions: (_forge, src) => src.commentId ?? 0,
    changeType: (_forge, src) => (src.typeName === 'added' ? 'ADDED' : src.typeName === 'removed' ? 'DELETED' : 'MODIFIED'),
  },
  IssueComment: {
    id: (_forge, src) => globalId('IssueComment', `${src.repo!.id}:${src.issue!.number}:${src.commentId ?? 0}`),
    body: (_forge, src) => src.name ?? '',
    createdAt: (_forge, src) => src.issue!.updatedAt,
    author: () => userSrc(),
  },
  CreateIssuePayload: {
    issue: (_forge, src) => src.nodes?.[0] ?? null,
  },
  CloseIssuePayload: {
    issue: (_forge, src) => src.nodes?.[0] ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_forge, src) => src.nodes?.[0] ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (_forge, src) => src.nodes?.[0] ?? null,
  },
  AddCommentPayload: {
    commentEdge: (_forge, src) => ({ __type: 'CommentEdge', nodes: src.nodes }),
  },
  CommentEdge: {
    node: (_forge, src) => src.nodes?.[0] ?? null,
    cursor: () => cursorOf(0),
  },
  __Type: {
    name: (_forge, src) => src.typeName ?? '',
    kind: (_forge, src) => (src.typeName !== undefined && src.typeName in ENUM_VALUES ? 'ENUM' : 'OBJECT'),
    fields: (_forge, src) => {
      const fields = src.typeName !== undefined ? TYPE_FIELDS[src.typeName] : undefined;
      return fields === undefined ? null : fields.map((name) => ({ __type: '__Field', fieldName: name }));
    },
    enumValues: (_forge, src) => {
      const values = src.typeName !== undefined ? ENUM_VALUES[src.typeName] : undefined;
      return values === undefined ? null : values.map((name) => ({ __type: '__EnumValue', fieldName: name }));
    },
  },
  __Field: {
    name: (_forge, src) => src.fieldName ?? '',
  },
  __EnumValue: {
    name: (_forge, src) => src.fieldName ?? '',
  },
};

// -------------------------------------------------------------------------------------------------
// Introspection tables (what __type reports; kept equal to the fields the resolvers implement)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'createdAt', 'updatedAt', 'issue', 'issues',
    'pullRequest', 'pullRequests',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'repository'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'author', 'repository',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeKnown(name: string): boolean {
  return name in TYPE_FIELDS || name in ENUM_VALUES;
}

// -------------------------------------------------------------------------------------------------
// Executor

interface ExecContext {
  forge: Forge;
  variables: Variables;
  fragments: DocumentNode['fragments'];
  errors: { message: string; path?: (string | number)[] }[];
}

function isSrc(value: unknown): value is Src {
  return isRecord(value) && typeof value.__type === 'string';
}

function executeSelection(ctx: ExecContext, typeName: string, src: Src, selections: SelectionNode[], path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(ctx, typeName, src, selection.selection, path));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === undefined || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelection(ctx, typeName, src, fragment.selection, path));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(ctx.forge, src, argsOf(selection, ctx.variables));
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection, [...path, key]);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(ctx, item, field, [...path, index]));
  if (isSrc(value)) {
    if (field.selection === undefined) return null;
    return executeSelection(ctx, value.__type, value, field.selection, path);
  }
  return value;
}

/** Execute one operation document; answers the {data, errors?} envelope. */
export function executeGraphQL(forge: Forge, query: string, variables: Variables, operationName?: string): { data: unknown; errors?: { message: string }[] } {
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    operationName !== undefined
      ? document.operations.find((op) => op.name === operationName)
      : document.operations.length === 1
        ? document.operations[0]
        : document.operations.find((op) => op.name === undefined) ?? document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation to execute' }] };
  }
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __type: rootType }, operation.selection, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// -------------------------------------------------------------------------------------------------
// HTTP entry (app.ts has already authenticated the caller)

/** Answer one POST /api/graphql body: a single operation or a batch array. */
export function handleGraphQL(forge: Forge, rawBody: Buffer): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, json: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): unknown => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'each operation needs a query string' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return executeGraphQL(forge, entry.query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map(runOne) };
  }
  return { status: 200, json: runOne(parsed) };
}
