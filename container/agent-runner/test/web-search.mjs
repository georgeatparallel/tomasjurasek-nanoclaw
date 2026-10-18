import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveWebSearch,
  SEARCH_URL,
  SEARCH_USER_AGENT,
} from '../dist/web-search.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'group');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const choose = (provider) =>
    put(path.join(home, '.claude/nanoclaw-search.json'), { provider });
  return {
    home,
    cwd,
    put,
    choose,
    resolve: (env = {}) => resolveWebSearch({ home, cwd, env }),
  };
}

test('fresh no-key settings select anonymous HTTP MCP and exclude native fallback', (t) => {
  const f = fixture(t);
  const value = f.resolve();
  assert.equal(value.provider, 'parallel');
  assert.deepEqual(value.mcpServers['parallel-search'], {
    type: 'http',
    url: SEARCH_URL,
    headers: { 'User-Agent': SEARCH_USER_AGENT },
  });
  assert.deepEqual(value.allowedTools, [
    'mcp__parallel-search__web_search',
    'mcp__parallel-search__web_fetch',
  ]);
  assert.deepEqual(value.disallowedTools, ['WebSearch', 'WebFetch']);
  assert.match(value.instruction, /Cite the returned URLs/);
});

test('saved provider and project overrides resolve without editing settings', (t) => {
  const f = fixture(t);
  f.choose('native');
  assert.equal(f.resolve().provider, 'native');
  const file = path.join(f.cwd, '.claude/nanoclaw-search.json');
  f.put(file, { provider: 'disabled' });
  const before = fs.readFileSync(file, 'utf8');
  const value = f.resolve();
  assert.equal(value.provider, 'disabled');
  assert.deepEqual(value.mcpServers, {});
  assert.deepEqual(value.disallowedTools, [
    'WebSearch',
    'WebFetch',
    'mcp__parallel-search__web_search',
    'mcp__parallel-search__web_fetch',
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

for (const location of ['user', 'project', 'local']) {
  test(`preserves existing ${location} MCP configuration until explicitly selected`, (t) => {
    const f = fixture(t);
    const saved = {
      type: 'http',
      url: 'https://example.com/custom',
      headers: { Authorization: 'Bearer saved' },
    };
    if (location === 'user')
      f.put(path.join(f.home, '.claude.json'), {
        mcpServers: { 'parallel-search': saved },
      });
    if (location === 'project')
      f.put(path.join(f.cwd, '.mcp.json'), {
        mcpServers: { 'parallel-search': saved },
      });
    if (location === 'local')
      f.put(path.join(f.home, '.claude.json'), {
        projects: { [f.cwd]: { mcpServers: { 'parallel-search': saved } } },
      });
    assert.equal(f.resolve().provider, 'native');
    f.choose('parallel');
    assert.deepEqual(f.resolve().mcpServers['parallel-search'], {
      ...saved,
      headers: { ...saved.headers, 'User-Agent': SEARCH_USER_AGENT },
    });
  });
}

for (const kind of ['allow', 'ask', 'deny']) {
  test(`saved ${kind} search permissions preserve previous routing`, (t) => {
    const f = fixture(t);
    f.put(path.join(f.cwd, '.claude/settings.local.json'), {
      permissions: { [kind]: ['WebSearch'] },
    });
    assert.equal(f.resolve().provider, 'native');
    assert.deepEqual(f.resolve().mcpServers, {});
  });
}

test('a saved MCP disable takes precedence over selecting Parallel', (t) => {
  const f = fixture(t);
  f.choose('parallel');
  f.put(path.join(f.home, '.claude.json'), {
    projects: { [f.cwd]: { disabledMcpServers: ['parallel-search'] } },
  });
  assert.equal(f.resolve().provider, 'disabled');
  assert.deepEqual(f.resolve().mcpServers, {});
});

for (const scope of ['user', 'local']) {
  test(`legacy ${scope} MCP rejection is authoritative before SDK migration`, (t) => {
    const f = fixture(t);
    const value = { disabledMcpjsonServers: ['parallel-search'] };
    f.put(
      path.join(f.home, '.claude.json'),
      scope === 'user' ? value : { projects: { [f.cwd]: value } },
    );
    assert.equal(f.resolve().provider, 'native');
    f.choose('parallel');
    assert.equal(f.resolve().provider, 'disabled');
    assert.deepEqual(f.resolve().mcpServers, {});
  });
}

test('legacy explicit MCP enables retain routing while generated empty defaults do not select native', (t) => {
  const f = fixture(t);
  const file = path.join(f.home, '.claude.json');
  f.put(file, {
    projects: { [f.cwd]: { enabledMcpjsonServers: ['existing'] } },
  });
  assert.equal(f.resolve().provider, 'native');
  f.put(file, { enableAllProjectMcpServers: true });
  assert.equal(f.resolve().provider, 'native');
  f.put(file, {
    projects: {
      [f.cwd]: {
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        enableAllProjectMcpServers: false,
      },
    },
  });
  assert.equal(f.resolve().provider, 'parallel');
});

test('settings credentials preserve routing and explicit auth uses local settings precedence', (t) => {
  const f = fixture(t);
  f.put(path.join(f.home, '.claude/settings.json'), {
    env: { PARALLEL_API_KEY: 'user-choice' },
  });
  assert.equal(f.resolve().provider, 'native');
  f.put(path.join(f.cwd, '.claude/settings.local.json'), {
    env: { PARALLEL_API_KEY: 'local-choice' },
  });
  f.choose('parallel');
  assert.equal(
    f.resolve({ PARALLEL_API_KEY: 'process-choice' }).mcpServers[
      'parallel-search'
    ].headers.Authorization,
    'Bearer local-choice',
  );
});

test('intentional search credentials keep existing routing; explicit Parallel uses its key', (t) => {
  const f = fixture(t);
  for (const key of [
    'PARALLEL_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
    'EXA_API_KEY',
  ]) {
    assert.equal(f.resolve({ [key]: 'configured' }).provider, 'native');
  }
  f.choose('parallel');
  assert.equal(
    f.resolve({ PARALLEL_API_KEY: 'configured' }).mcpServers['parallel-search']
      .headers.Authorization,
    'Bearer configured',
  );
});

test('malformed configuration fails visibly rather than changing providers', (t) => {
  const f = fixture(t);
  f.choose('typo');
  assert.throws(() => f.resolve(), /provider must be/);
  fs.writeFileSync(path.join(f.home, '.claude/nanoclaw-search.json'), '{');
  assert.throws(() => f.resolve(), SyntaxError);
});

test('respects an overridden Claude config directory and custom User-Agent', (t) => {
  const f = fixture(t);
  const configDir = path.join(f.home, 'custom-claude');
  f.put(path.join(configDir, 'nanoclaw-search.json'), { provider: 'parallel' });
  f.put(path.join(configDir, '.claude.json'), {
    mcpServers: {
      'parallel-search': {
        type: 'http',
        url: 'https://example.com/mcp?mode=fast',
        headers: {
          'user-agent': 'Chosen client',
          Authorization: 'Bearer saved',
        },
      },
    },
  });
  const server = f.resolve({ CLAUDE_CONFIG_DIR: configDir }).mcpServers[
    'parallel-search'
  ];
  assert.equal(server.url, 'https://example.com/mcp?mode=fast');
  assert.deepEqual(server.headers, {
    'user-agent': 'Chosen client',
    Authorization: 'Bearer saved',
  });
});

test('configuration script writes only the group choice and rejects path traversal', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(
    new URL(
      '../../../.claude/skills/add-parallel/scripts/configure-search.mjs',
      import.meta.url,
    ),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: f.cwd,
      encoding: 'utf8',
    });
  assert.equal(run('main', 'parallel').status, 0);
  const file = path.join(
    f.cwd,
    'data/sessions/main/.claude/nanoclaw-search.json',
  );
  f.put(file, { provider: 'parallel', other: true });
  assert.equal(run('main', 'native').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    provider: 'native',
    other: true,
  });
  assert.equal(run('../escape', 'parallel').status, 1);
});
