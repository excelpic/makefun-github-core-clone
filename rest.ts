// The REST v3 surface: /api/v3 routes for repositories, contents, branches, commits, git refs,
// labels, issues, comments and pull requests. Every handler works on the shared Forge store, so
// anything created here is immediately visible to git, GraphQL and MCP (and vice versa). Reply
// shapes follow GitHub's: error bodies always carry a string `message`, and the HTTP shell in
// app.ts adds the JSON content type and the X-GitHub-Request-Id header to every reply.

import { ZERO_OID } from './git.ts';
import type { Comment, Forge, Issue, Label, Pull, Repo } from './store.ts';

export interface RestRequest {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when the request carried none. */
  body: unknown;
  /** The request's own origin (scheme://host), for absolute Link headers. */
  origin: string;
}

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function fail(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyOf(req: RestRequest): Json {
  return isRecord(req.body) ? req.body : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// -------------------------------------------------------------------------------------------------
// Serialisers

function userJson(forge: Forge): Json {
  return { login: forge.viewer, id: 1000, type: 'User' };
}

export function repoJson(forge: Forge, repo: Repo): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(forge),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

/** A stable numeric REST id for an issue or pull request (GraphQL has its own global ids). */
function restObjectId(repo: Repo, number: number): number {
  return repo.id * 100_000 + number;
}

function labelJson(label: Label): Json {
  let hash = 0;
  for (let i = 0; i < label.name.length; i += 1) hash = (hash * 31 + label.name.charCodeAt(i)) >>> 0;
  return { id: hash, name: label.name, color: label.color, description: null, default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Json {
  return {
    id: restObjectId(repo, issue.number),
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: userJson(forge),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(forge: Forge, comment: Comment): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(forge),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Json {
  const headSha = forge.branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: restObjectId(repo, pull.number),
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// -------------------------------------------------------------------------------------------------
// Pagination (the /user/repos Link chain is followed by the suite, so it must be exact)

function pageParams(req: RestRequest): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(req: RestRequest, items: readonly T[], path: string): { page: T[]; headers?: Record<string, string> } {
  const { perPage, page } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const link = (target: number, rel: string): string => `<${req.origin}${path}?per_page=${perPage}&page=${target}>; rel="${rel}"`;
    headers.link = `${link(page + 1, 'next')}, ${link(lastPage, 'last')}`;
  }
  return { page: slice, headers: Object.keys(headers).length > 0 ? headers : undefined };
}

// -------------------------------------------------------------------------------------------------
// Route handlers

function root(req: RestRequest): RestResult {
  return {
    status: 200,
    json: {
      current_user_url: `${req.origin}/api/v3/user`,
      current_user_repositories_url: `${req.origin}/api/v3/user/repos`,
      repository_url: `${req.origin}/api/v3/repos/{owner}/{repo}`,
      issue_url: `${req.origin}/api/v3/repos/{owner}/{repo}/issues`,
    },
    headers: { 'x-oauth-scopes': 'repo, user, admin:org' },
  };
}

function createRepo(req: RestRequest): RestResult {
  const body = bodyOf(req);
  const name = stringOf(body.name);
  if (name === undefined || name === '' || name.includes('/') || name.includes(' ')) {
    return fail(422, 'Validation Failed: name is required and must be a valid repository name');
  }
  const created = req.forge.createRepo(name, {
    description: stringOf(body.description) ?? '',
    isPrivate: typeof body.private === 'boolean' ? body.private : false,
  });
  if (created === 'exists') return fail(422, 'name already exists on this account');
  return { status: 201, json: repoJson(req.forge, created) };
}

function listUserRepos(req: RestRequest): RestResult {
  const all = req.forge.listRepos().map((repo) => repoJson(req.forge, repo));
  const { page, headers } = paginate(req, all, '/api/v3/user/repos');
  return { status: 200, json: page, headers };
}

function patchRepo(req: RestRequest, repo: Repo): RestResult {
  const body = bodyOf(req);
  const description = stringOf(body.description);
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const name = stringOf(body.name);
  if (name !== undefined && name !== '' && name !== repo.name && !name.includes('/')) {
    req.forge.renameRepo(repo, name);
  }
  return { status: 200, json: repoJson(req.forge, repo) };
}

function listBranches(req: RestRequest, repo: Repo): RestResult {
  const branches: Json[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 200, json: branches };
}

function listCommits(req: RestRequest, repo: Repo): RestResult {
  const ref = req.query.get('sha') ?? undefined;
  const tip = req.forge.resolveRef(repo, ref);
  if (tip === null) {
    if (repo.refs.size === 0) return fail(409, 'Git Repository is empty');
    return fail(404, 'Not Found');
  }
  const identity = (line: string): Json => {
    const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: repo.createdAt };
    return { name: match[1]!, email: match[2]!, date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString() };
  };
  const commits = req.forge.listCommits(repo, tip).map((commit) => ({
    sha: commit.sha,
    commit: {
      message: commit.message,
      author: identity(commit.author),
      committer: identity(commit.committer),
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  }));
  return { status: 200, json: commits };
}

function createRef(req: RestRequest, repo: Repo): RestResult {
  const body = bodyOf(req);
  const ref = stringOf(body.ref);
  const sha = stringOf(body.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !repo.objects.has(sha)) {
    return fail(422, 'Validation Failed: ref and a valid object sha are required');
  }
  const existing = repo.refs.get(ref);
  if (existing !== undefined && existing !== sha) return fail(422, `Reference already exists: ${ref}`);
  repo.refs.set(ref, sha);
  const object = repo.objects.get(sha)!;
  return { status: 201, json: { ref, object: { sha, type: object.type } } };
}

function getRef(repo: Repo, ref: string): RestResult {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return fail(404, 'Not Found');
  const object = repo.objects.get(oid);
  return { status: 200, json: { ref, object: { sha: oid, type: object?.type ?? 'commit' } } };
}

function listRefs(repo: Repo): RestResult {
  const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } }));
  return { status: 200, json: refs };
}

function contents(req: RestRequest, repo: Repo, pathParts: string[]): RestResult {
  const forge = req.forge;
  const path = pathParts.join('/');
  if (req.method === 'GET') {
    const found = forge.readPath(repo, path, req.query.get('ref') ?? undefined);
    if (found === null) return fail(404, 'Not Found');
    if (found.kind === 'dir') {
      return {
        status: 200,
        json: found.entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.sha,
          size: entry.type === 'file' ? (repo.objects.get(entry.sha)?.data.length ?? 0) : 0,
        })),
      };
    }
    return {
      status: 200,
      json: {
        type: 'file',
        name: found.name,
        path: found.path,
        sha: found.sha,
        size: found.size,
        encoding: 'base64',
        content: found.data.toString('base64'),
      },
    };
  }
  if (req.method === 'PUT') {
    const body = bodyOf(req);
    const content = stringOf(body.content);
    if (content === undefined) return fail(422, 'Validation Failed: content is required');
    const result = forge.putFile(repo, {
      path,
      content: Buffer.from(content, 'base64'),
      message: stringOf(body.message) ?? '',
      branch: stringOf(body.branch),
      sha: stringOf(body.sha),
    });
    if ('error' in result) return fail(result.error, result.message);
    return {
      status: result.status,
      json: {
        content: { name: path.split('/').pop() ?? path, path, sha: result.blobSha, size: Buffer.from(content, 'base64').length, encoding: 'base64' },
        commit: { sha: result.commitSha },
      },
    };
  }
  if (req.method === 'DELETE') {
    const body = bodyOf(req);
    const result = forge.deleteFile(repo, {
      path,
      message: stringOf(body.message) ?? '',
      branch: stringOf(body.branch),
      sha: stringOf(body.sha),
    });
    if ('error' in result) return fail(result.error, result.message);
    return { status: 200, json: { content: null, commit: { sha: result.commitSha } } };
  }
  return fail(404, 'Not Found');
}

function labels(req: RestRequest, repo: Repo): RestResult {
  if (req.method === 'GET') return { status: 200, json: [...repo.labels.values()].map(labelJson) };
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const name = stringOf(body.name);
    if (name === undefined || name === '') return fail(422, 'Validation Failed: name is required');
    const created = req.forge.createLabel(repo, name, stringOf(body.color) ?? 'ededed');
    if (created === 'exists') return fail(422, 'Validation Failed: label already exists');
    return { status: 201, json: labelJson(created) };
  }
  return fail(404, 'Not Found');
}

function issueLabels(body: Json): string[] | undefined {
  if (!Array.isArray(body.labels)) return undefined;
  const names: string[] = [];
  for (const entry of body.labels) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

function issues(req: RestRequest, repo: Repo): RestResult {
  const forge = req.forge;
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const title = stringOf(body.title);
    if (title === undefined || title === '') return fail(422, 'Validation Failed: title is required');
    const created = forge.createIssue(repo, { title, body: stringOf(body.body) ?? '', labels: issueLabels(body) });
    if ('badLabel' in created) return fail(422, `Validation Failed: label '${created.badLabel}' does not exist`);
    return { status: 201, json: issueJson(forge, repo, created) };
  }
  if (req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    const direction = req.query.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const { page } = paginate(req, list, '');
    return { status: 200, json: page.map((issue) => issueJson(forge, repo, issue)) };
  }
  return fail(404, 'Not Found');
}

function oneIssue(req: RestRequest, repo: Repo, number: number): RestResult {
  const forge = req.forge;
  const issue = repo.issues.get(number);
  if (issue === undefined) return fail(404, 'Not Found');
  if (req.method === 'GET') return { status: 200, json: issueJson(forge, repo, issue) };
  if (req.method === 'PATCH') {
    const body = bodyOf(req);
    const state = stringOf(body.state);
    if (state === 'open' || state === 'closed') issue.state = state;
    const title = stringOf(body.title);
    if (title !== undefined) issue.title = title;
    const text = stringOf(body.body);
    if (text !== undefined) issue.body = text;
    const names = issueLabels(body);
    if (names !== undefined) {
      for (const name of names) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label '${name}' does not exist`);
      issue.labels = names;
    }
    issue.updatedAt = forge.stamp();
    return { status: 200, json: issueJson(forge, repo, issue) };
  }
  return fail(404, 'Not Found');
}

function comments(req: RestRequest, repo: Repo, number: number): RestResult {
  const forge = req.forge;
  const issue = repo.issues.get(number);
  if (issue === undefined) return fail(404, 'Not Found');
  if (req.method === 'GET') return { status: 200, json: issue.comments.map((comment) => commentJson(forge, comment)) };
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const text = stringOf(body.body);
    if (text === undefined) return fail(422, 'Validation Failed: body is required');
    const comment = forge.addComment(repo, issue, text);
    return { status: 201, json: commentJson(forge, comment) };
  }
  return fail(404, 'Not Found');
}

function pulls(req: RestRequest, repo: Repo): RestResult {
  const forge = req.forge;
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const title = stringOf(body.title);
    const head = stringOf(body.head);
    const base = stringOf(body.base);
    if (title === undefined || head === undefined || base === undefined) return fail(422, 'Validation Failed: title, head and base are required');
    const created = forge.createPull(repo, { title, body: stringOf(body.body) ?? '', head, base });
    if ('error' in created) return fail(created.error, created.message);
    return { status: 201, json: pullJson(forge, repo, created) };
  }
  if (req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    list.sort((a, b) => b.number - a.number);
    const { page } = paginate(req, list, '');
    return { status: 200, json: page.map((pull) => pullJson(forge, repo, pull)) };
  }
  return fail(404, 'Not Found');
}

function onePull(req: RestRequest, repo: Repo, number: number, tail: string[]): RestResult {
  const forge = req.forge;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return fail(404, 'Not Found');
  if (tail.length === 0 && req.method === 'GET') return { status: 200, json: pullJson(forge, repo, pull) };
  if (tail[0] === 'files' && req.method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
    }));
    return { status: 200, json: files };
  }
  if (tail[0] === 'merge' && req.method === 'PUT') {
    const body = bodyOf(req);
    const method = stringOf(body.merge_method) ?? 'merge';
    const result = forge.mergePull(repo, pull, method === 'squash' ? 'squash' : 'merge');
    if ('conflict' in result) return fail(405, 'Pull Request is not mergeable: the head and base branches diverged on the same files');
    if ('error' in result) return fail(405, result.error);
    return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return fail(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// The router

export function routeRest(req: RestRequest): RestResult {
  const forge = req.forge;
  const [first, second, third, ...rest] = req.segments;

  if (req.segments.length === 0) {
    return req.method === 'GET' ? root(req) : fail(404, 'Not Found');
  }
  if (first === 'meta' && req.segments.length === 1) {
    return req.method === 'GET' ? { status: 200, json: { installed_version: '3.10.0' } } : fail(404, 'Not Found');
  }
  if (first === 'user' && req.segments.length === 1) {
    return req.method === 'GET' ? { status: 200, json: userJson(forge) } : fail(404, 'Not Found');
  }
  if (first === 'user' && second === 'repos' && req.segments.length === 2) {
    if (req.method === 'POST') return createRepo(req);
    if (req.method === 'GET') return listUserRepos(req);
    return fail(404, 'Not Found');
  }
  if (first !== 'repos' || second === undefined || third === undefined) return fail(404, 'Not Found');

  const repo = forge.repo(second, third);
  if (repo === null) return fail(404, 'Not Found');
  const [area, ...tail] = rest;

  if (rest.length === 0) {
    if (req.method === 'GET') return { status: 200, json: repoJson(forge, repo) };
    if (req.method === 'PATCH') return patchRepo(req, repo);
    if (req.method === 'DELETE') {
      forge.deleteRepo(second, third);
      return { status: 204 };
    }
    return fail(404, 'Not Found');
  }
  if (area === 'branches') {
    if (tail.length === 0) return req.method === 'GET' ? listBranches(req, repo) : fail(404, 'Not Found');
    if (req.method !== 'GET') return fail(404, 'Not Found');
    const name = tail.join('/');
    const tip = forge.branchTip(repo, name);
    return tip === null ? fail(404, 'Not Found') : { status: 200, json: { name, commit: { sha: tip }, protected: false } };
  }
  if (area === 'commits') {
    return req.method === 'GET' && tail.length === 0 ? listCommits(req, repo) : fail(404, 'Not Found');
  }
  if (area === 'git' && tail[0] === 'refs') {
    if (tail.length === 1) {
      if (req.method === 'POST') return createRef(req, repo);
      if (req.method === 'GET') return listRefs(repo);
      return fail(404, 'Not Found');
    }
    return req.method === 'GET' ? getRef(repo, `refs/${tail.slice(1).join('/')}`) : fail(404, 'Not Found');
  }
  if (area === 'contents') return contents(req, repo, tail);
  if (area === 'labels' && tail.length === 0) return labels(req, repo);
  if (area === 'issues') {
    if (tail.length === 0) return issues(req, repo);
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isFinite(number)) return fail(404, 'Not Found');
    if (tail.length === 1) return oneIssue(req, repo, number);
    if (tail.length === 2 && tail[1] === 'comments') return comments(req, repo, number);
    return fail(404, 'Not Found');
  }
  if (area === 'pulls') {
    if (tail.length === 0) return pulls(req, repo);
    const number = Number.parseInt(tail[0]!, 10);
    if (!Number.isFinite(number)) return fail(404, 'Not Found');
    return onePull(req, repo, number, tail.slice(1));
  }
  return fail(404, 'Not Found');
}
