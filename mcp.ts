// The MCP surface: github-mcp-server's core tools over the same Forge store, spoken as JSON-RPC
// 2.0 over Streamable HTTP at POST /mcp. The server answers the current revision's
// `server/discover` (so a modern client never needs a handshake) and also speaks the legacy
// `initialize` + `notifications/initialized` era for clients that predate discover. Tools act
// on the shared store, so an issue created here is the same object REST reads back, with the
// same ids — the parity the suite's rest-parity check measures.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, Repo } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool table. Serialised identically on every tools/list call (the suite compares bytes). */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: stringProp('The repository name.'),
      description: stringProp('A short description of the repository.'),
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: stringProp('The repository owner (login).'),
      repo: stringProp('The repository name.'),
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: stringProp('The repository owner (login).'),
      repo: stringProp('The repository name.'),
      title: stringProp('The issue title.'),
      body: stringProp('The issue body.'),
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: stringProp('The repository owner (login).'),
      repo: stringProp('The repository name.'),
      state: stringProp('Filter by state: open, closed or all.'),
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: stringProp('The repository owner (login).'),
      repo: stringProp('The repository name.'),
      title: stringProp('The pull request title.'),
      body: stringProp('The pull request body.'),
      head: stringProp('The head branch name.'),
      base: stringProp('The base branch name.'),
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    properties: {
      owner: stringProp('The repository owner (login).'),
      repo: stringProp('The repository name.'),
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListResult(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolOk(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  return forge.repo(owner, name);
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string } } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of def.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      if (created === 'exists') return { result: toolError(`Repository ${repoName} already exists`) };
      return { result: toolOk(repoJson(forge, created)) };
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolError('Repository not found') };
      return { result: toolOk(repoJson(forge, repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolError('Repository not found') };
      const created = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('badLabel' in created) return { result: toolError(`label '${created.badLabel}' does not exist`) };
      return { result: toolOk(issueJson(forge, repo, created)) };
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      return { result: toolOk(list.map((issue) => issueJson(forge, repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolError('Repository not found') };
      const created = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in created) return { result: toolError(created.message) };
      return { result: toolOk(pullJson(forge, repo, created)) };
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === null) return { result: toolError('Repository not found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { result: toolError('Pull request not found') };
      const merged = forge.mergePull(repo, pull, 'merge');
      if ('conflict' in merged) return { result: toolError('Pull request is not mergeable') };
      if ('error' in merged) return { result: toolError(merged.error) };
      return { result: toolOk(pullJson(forge, repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

export interface McpResponse {
  status: number;
  /** The JSON-RPC envelope to serialise, or null for an empty (notification) answer. */
  json: unknown;
}

/** Answer one POST /mcp body. Authentication has already happened in app.ts. */
export function handleMcp(forge: Forge, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = parsed.id;
  if (id === undefined || id === null) {
    // A notification (notifications/initialized and friends): accepted, never answered.
    return { status: 202, json: null };
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const ok = (result: unknown): McpResponse => ({ status: 200, json: { jsonrpc: '2.0', id, result } });
  const err = (code: number, message: string): McpResponse => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } });

  switch (parsed.method) {
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok(toolListResult());
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(forge, toolName, toolArgs);
      if (outcome.error !== undefined) return err(outcome.error.code, outcome.error.message);
      return ok(outcome.result);
    }
    default:
      return err(-32601, `Method not found: ${parsed.method}`);
  }
}
