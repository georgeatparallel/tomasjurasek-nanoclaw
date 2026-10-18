import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

const SERVER = 'parallel-search';
const NATIVE_TOOLS = ['WebSearch', 'WebFetch'];
const PARALLEL_TOOLS = [
  `mcp__${SERVER}__web_search`,
  `mcp__${SERVER}__web_fetch`,
];
export const SEARCH_URL = 'https://search.parallel.ai/mcp';
export const SEARCH_USER_AGENT =
  'NanoClaw (https://github.com/tomasjurasek/nanoclaw)';

type Provider = 'parallel' | 'native' | 'disabled';
interface SavedSettings {
  provider?: unknown;
  mcpServers?: Record<string, McpServerConfig>;
  projects?: Record<string, SavedSettings>;
  disabledMcpServers?: string[];
  disabledMcpjsonServers?: string[];
  enabledMcpjsonServers?: string[];
  enableAllProjectMcpServers?: boolean;
  env?: NodeJS.ProcessEnv;
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
}

function readJson(file: string): SavedSettings {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Expected an object in ${file}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export interface WebSearchOptions {
  provider: Provider;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  instruction?: string;
}

/** Resolve once per query, leaving Claude's existing settings files untouched. */
export function resolveWebSearch({
  cwd = process.cwd(),
  home = os.homedir(),
  env = process.env,
}: {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
} = {}): WebSearchOptions {
  const settingsDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const legacyConfig = path.join(settingsDir, '.config.json');
  const user = readJson(
    fs.existsSync(legacyConfig)
      ? legacyConfig
      : path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
  );
  const local = user.projects?.[cwd] ?? {};
  const project = readJson(path.join(cwd, '.mcp.json'));
  const settings = [
    readJson(path.join(settingsDir, 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.json')),
    readJson(path.join(cwd, '.claude', 'settings.local.json')),
  ];
  const configs = [
    readJson(path.join(settingsDir, 'nanoclaw-search.json')),
    readJson(path.join(cwd, '.claude', 'nanoclaw-search.json')),
  ];
  const selected = configs.reduce<unknown>(
    (value, config) => ('provider' in config ? config.provider : value),
    undefined,
  );
  if (
    selected !== undefined &&
    !['parallel', 'native', 'disabled'].includes(selected as string)
  ) {
    throw new Error(
      'nanoclaw-search.json provider must be parallel, native or disabled',
    );
  }

  // Be conservative with pre-existing installations: any saved MCP setup or
  // search permission/credential keeps the previous SDK routing until opted in.
  const servers = {
    ...user.mcpServers,
    ...project.mcpServers,
    ...local.mcpServers,
  };
  const hasPermissions = settings.some(
    (config) =>
      (['allow', 'ask', 'deny'] as const).some((kind) =>
        (config.permissions?.[kind] ?? []).some((rule) =>
          /WebSearch|WebFetch|mcp__|\*/.test(rule),
        ),
      ) ||
      [
        'enabledMcpjsonServers',
        'disabledMcpjsonServers',
        'enableAllProjectMcpServers',
      ].some((key) => key in config),
  );
  const disabled = [
    ...(user.disabledMcpServers ?? []),
    ...(local.disabledMcpServers ?? []),
    ...(user.disabledMcpjsonServers ?? []),
    ...(local.disabledMcpjsonServers ?? []),
    ...settings.flatMap((config) => config.disabledMcpjsonServers ?? []),
  ];
  // Older SDKs stored project MCP consent in .claude.json before migrating it
  // to settings.local.json. Empty lists/false are also SDK-generated defaults.
  const hasLegacyConsent = [user, local].some(
    (config) =>
      (config.enabledMcpjsonServers?.length ?? 0) > 0 ||
      config.enableAllProjectMcpServers === true,
  );
  const searchEnv = Object.assign(
    {},
    env,
    ...settings.map((config) => config.env),
  );
  const hasCredentials = [
    'PARALLEL_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
    'EXA_API_KEY',
  ].some((key) => Boolean(searchEnv[key]));
  const savedChoice =
    Object.keys(servers).length > 0 ||
    hasPermissions ||
    hasLegacyConsent ||
    disabled.length > 0 ||
    hasCredentials;
  let provider = (selected ??
    (savedChoice ? 'native' : 'parallel')) as Provider;

  // A saved server disable remains authoritative even after selecting Parallel.
  if (provider === 'parallel' && disabled.includes(SERVER))
    provider = 'disabled';
  if (provider === 'native') {
    return {
      provider,
      allowedTools: NATIVE_TOOLS,
      disallowedTools: [],
      mcpServers: {},
    };
  }
  if (provider === 'disabled') {
    return {
      provider,
      allowedTools: [],
      disallowedTools: [...NATIVE_TOOLS, `mcp__${SERVER}__*`],
      mcpServers: {},
    };
  }

  const server: McpServerConfig = servers[SERVER] ?? {
    type: 'http',
    url: SEARCH_URL,
    headers: searchEnv.PARALLEL_API_KEY
      ? { Authorization: `Bearer ${searchEnv.PARALLEL_API_KEY}` }
      : {},
  };
  // Preserve intentionally configured URLs, authentication and transport.
  if (server.type === 'http' || server.type === 'sse') {
    server.headers = { ...server.headers };
    if (
      !Object.keys(server.headers).some(
        (key) => key.toLowerCase() === 'user-agent',
      )
    ) {
      server.headers['User-Agent'] = SEARCH_USER_AGENT;
    }
  }
  return {
    provider,
    allowedTools: PARALLEL_TOOLS,
    disallowedTools: NATIVE_TOOLS,
    mcpServers: { [SERVER]: server },
    instruction:
      'Use mcp__parallel-search__web_search for web searches and ' +
      'mcp__parallel-search__web_fetch to read source URLs. Cite the returned URLs. ' +
      'If a search or fetch fails, report the error; do not silently switch providers.',
  };
}
