// Scripted model responses exercise the real SDK dispatcher without model inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveWebSearch, SEARCH_USER_AGENT } from '../dist/web-search.js';

const sourceUrl = 'https://example.com/nanoclaw?source=search&lang=en';
const steps = [
  {
    name: 'web_search',
    input: {
      objective: 'Find NanoClaw',
      search_queries: ['NanoClaw container agent website'],
    },
  },
  { name: 'web_fetch', input: { urls: [sourceUrl] } },
];
const tools = [
  {
    name: 'web_search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string' },
        search_queries: { type: 'array', items: { type: 'string' } },
      },
      required: ['objective', 'search_queries'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Read a source URL',
    inputSchema: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' } } },
      required: ['urls'],
    },
  },
];

function streamResponse(res, model, content) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
    );
  event('message_start', {
    message: {
      id: 'fixture-message',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block:
      content.type === 'text'
        ? { type: 'text', text: '' }
        : { ...content, input: {} },
  });
  event('content_block_delta', {
    index: 0,
    delta:
      content.type === 'text'
        ? { type: 'text_delta', text: content.text }
        : {
            type: 'input_json_delta',
            partial_json: JSON.stringify(content.input),
          },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: {
      stop_reason: content.type === 'text' ? 'end_turn' : 'tool_use',
      stop_sequence: null,
    },
    usage: { output_tokens: 30 },
  });
  event('message_stop', {});
  res.end();
}

async function exercise(
  t,
  {
    mode = 'success',
    provider = 'parallel',
    deny = false,
    legacyDisable = false,
    settingsCredential = false,
    savedServer = false,
    forceCall = false,
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sdk-search-'));
  const home = path.join(root, 'home'),
    cwd = path.join(root, 'group');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(cwd);
  const abortController = new AbortController();
  const requests = [],
    modelRequests = [],
    consumed = [];
  let result, failure;
  const fixture = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = JSON.parse(data);
    if (req.url === '/mcp') {
      requests.push({
        method: body.method,
        params: body.params,
        headers: req.headers,
        url: req.url,
      });
      if (!('id' in body)) {
        res.writeHead(202).end();
        return;
      }
      let value;
      if (body.method === 'initialize') {
        value = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'nanoclaw-fixture', version: '1' },
        };
      } else if (body.method === 'tools/list') value = { tools };
      else if (body.method === 'tools/call') {
        if (mode === 'cancel') {
          setTimeout(() => abortController.abort(), 50);
          return;
        }
        if (mode === 'timeout') return;
        value =
          mode === 'error'
            ? {
                isError: true,
                content: [
                  { type: 'text', text: 'Fixture service unavailable' },
                ],
              }
            : {
                content: [
                  {
                    type: 'text',
                    text: `${body.params.name === 'web_search' ? 'Found' : 'Read'} fixture source: ${sourceUrl}`,
                  },
                ],
              };
      } else value = {};
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }));
      return;
    }
    if (req.url.includes('count_tokens')) {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"input_tokens":100}');
      return;
    }
    modelRequests.push(body);
    const results = body.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c.type === 'tool_result');
    consumed.push(...results);
    const stop = mode !== 'success' && results.length > 0;
    const step = steps[results.length];
    const content =
      !forceCall &&
      !legacyDisable &&
      (search.provider === 'disabled' || search.provider === 'native')
        ? { type: 'text', text: 'Routing inspected.' }
        : !stop && step
          ? {
              type: 'tool_use',
              id: `fixture-tool-${results.length}`,
              name: `mcp__parallel-search__${step.name}`,
              input: step.input,
            }
          : {
              type: 'text',
              text: `Consumed SDK tool output: ${JSON.stringify(results.at(-1))}`,
            };
    streamResponse(res, body.model, content);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${fixture.address().port}`;
  if (provider !== 'native' && !settingsCredential) {
    fs.writeFileSync(
      path.join(home, '.claude/nanoclaw-search.json'),
      JSON.stringify({ provider }),
    );
  }
  // Exercise a saved server override through the resolver, not a rewritten result.
  if ((provider === 'parallel' || savedServer) && !settingsCredential) {
    fs.writeFileSync(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'parallel-search': { type: 'http', url: `${endpoint}/mcp` },
        },
      }),
    );
  }
  if (provider === 'native') {
    fs.writeFileSync(
      path.join(home, '.claude/nanoclaw-search.json'),
      '{"provider":"native"}',
    );
  }
  if (deny)
    fs.writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({
        permissions: { deny: ['mcp__parallel-search__web_search'] },
      }),
    );
  if (legacyDisable)
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        projects: { [cwd]: { disabledMcpjsonServers: ['parallel-search'] } },
      }),
    );
  if (settingsCredential)
    fs.writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({ env: { PARALLEL_API_KEY: 'saved-fixture-key' } }),
    );
  const search = resolveWebSearch({ cwd, home, env: {} });
  const env = {
    ...Object.fromEntries(
      Object.keys(process.env).map((key) => [key, undefined]),
    ),
    PATH: process.env.PATH,
    HOME: home,
    ANTHROPIC_API_KEY: 'fixture-only',
    ANTHROPIC_BASE_URL: endpoint,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    MCP_TOOL_TIMEOUT: mode === 'timeout' ? '200' : '5000',
    // Reproduce the runner's existing permission mode. Only scripted model
    // responses and local fixture tools execute in these tests.
    ...(process.getuid?.() === 0 ? { IS_SANDBOX: '1' } : {}),
  };
  const timer = setTimeout(() => abortController.abort(), 30000);
  try {
    const conversation = query({
      prompt: 'Find NanoClaw, read its source and cite the source URL.',
      options: {
        cwd,
        env,
        settingSources: ['project', 'user'],
        allowedTools: search.allowedTools,
        disallowedTools: search.disallowedTools,
        mcpServers: search.mcpServers,
        systemPrompt: search.instruction,
        abortController,
        maxTurns: 4,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    for await (const message of conversation) {
      if (message.type === 'result') result = message;
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { result, failure, requests, modelRequests, consumed };
}

test(
  'real SDK discovers tools, searches, fetches the returned URL, and consumes output',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t);
    assert.equal(run.failure, undefined);
    assert.equal(run.result.subtype, 'success');
    assert.match(run.result.result, /Read fixture source/);
    assert.ok(run.result.result.includes(sourceUrl));
    const calls = run.requests.filter((r) => r.method === 'tools/call');
    assert.deepEqual(
      calls.map((r) => ({
        name: r.params.name,
        arguments: r.params.arguments,
      })),
      steps.map((s) => ({ name: s.name, arguments: s.input })),
    );
    for (const request of run.requests) {
      assert.equal(request.headers['user-agent'], SEARCH_USER_AGENT);
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.url, '/mcp');
    }
    assert.ok(run.requests.some((r) => r.method === 'tools/list'));
    for (const request of run.modelRequests)
      assert.ok(
        !request.tools.some((tool) =>
          ['WebSearch', 'WebFetch'].includes(tool.name),
        ),
      );
  },
);

for (const mode of ['error', 'timeout']) {
  test(
    `real SDK surfaces ${mode} through tool-result consumption without native fallback`,
    { timeout: 35000 },
    async (t) => {
      const run = await exercise(t, { mode });
      assert.equal(run.failure, undefined);
      assert.equal(run.result.subtype, 'success');
      assert.match(
        run.result.result,
        mode === 'error' ? /Fixture service unavailable/ : /timed out|timeout/i,
      );
      assert.equal(
        run.requests.filter((r) => r.method === 'tools/call').length,
        1,
      );
      for (const request of run.modelRequests)
        assert.ok(
          !request.tools.some((tool) =>
            ['WebSearch', 'WebFetch'].includes(tool.name),
          ),
        );
    },
  );
}

test(
  'real SDK cancellation stops an in-flight search',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t, { mode: 'cancel' });
    assert.ok(run.failure || run.result?.is_error);
    assert.equal(
      run.requests.filter((r) => r.method === 'tools/call').length,
      1,
    );
  },
);

for (const provider of ['native', 'disabled']) {
  test(
    `real SDK respects ${provider} routing and does not connect to Parallel`,
    { timeout: 35000 },
    async (t) => {
      const run = await exercise(t, { provider });
      assert.equal(run.failure, undefined);
      assert.equal(run.result.subtype, 'success');
      assert.equal(run.requests.length, 0);
      const names = run.modelRequests.at(-1).tools.map((tool) => tool.name);
      assert.equal(names.includes('WebSearch'), provider === 'native');
      assert.equal(names.includes('WebFetch'), provider === 'native');
      assert.ok(
        !names.some((name) => name.startsWith('mcp__parallel-search__')),
      );
    },
  );
}

test(
  'real SDK honors an explicit saved tool denial',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t, { deny: true, mode: 'error' });
    assert.equal(run.failure, undefined);
    assert.equal(
      run.requests.filter((r) => r.method === 'tools/call').length,
      0,
    );
    assert.match(run.result.result, /No such tool available/);
    for (const request of run.modelRequests) {
      assert.ok(
        !request.tools.some(
          (tool) => tool.name === 'mcp__parallel-search__web_search',
        ),
      );
    }
  },
);

test(
  'real SDK does not bypass a legacy saved MCP rejection',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t, { legacyDisable: true, mode: 'error' });
    assert.equal(run.failure, undefined);
    assert.equal(
      run.requests.filter((r) => r.method === 'tools/call').length,
      0,
    );
    for (const request of run.modelRequests)
      assert.ok(
        !request.tools.some((tool) =>
          tool.name.startsWith('mcp__parallel-search__'),
        ),
      );
  },
);

test(
  'settings-provided credentials keep native routing without anonymous requests',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t, { settingsCredential: true });
    assert.equal(run.failure, undefined);
    assert.equal(run.result.subtype, 'success');
    assert.equal(run.requests.length, 0);
    const names = run.modelRequests.at(-1).tools.map((tool) => tool.name);
    assert.ok(names.includes('WebSearch'));
    assert.ok(!names.some((name) => name.startsWith('mcp__parallel-search__')));
  },
);

test(
  'disabled search excludes saved Parallel tools even if the model attempts a call',
  { timeout: 35000 },
  async (t) => {
    const run = await exercise(t, {
      provider: 'disabled',
      savedServer: true,
      forceCall: true,
      mode: 'error',
    });
    assert.equal(run.failure, undefined);
    assert.equal(
      run.requests.filter((r) => r.method === 'tools/call').length,
      0,
    );
    assert.match(run.result.result, /No such tool available/);
    for (const request of run.modelRequests)
      assert.ok(
        !request.tools.some((tool) =>
          tool.name.startsWith('mcp__parallel-search__'),
        ),
      );
  },
);
