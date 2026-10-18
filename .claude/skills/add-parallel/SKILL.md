---
name: add-parallel
description: Add free web search and page fetching to the container agent with Parallel Search MCP, without an account or API key.
---

# Add Parallel Search

Install the executable `skill/parallel-search` feature branch. With this skill
installed, unconfigured agents use [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
for web searches and page fetching. Search uses Fast mode. No Parallel account or
API key is needed; anonymous use has service limits.

This skill adds search and fetch only. Keep any existing Parallel Task integration
and its credentials and permission requirements unchanged.

## 1. Merge the feature branch

If `container/agent-runner/src/web-search.ts` already exists, the code is installed;
skip the merge. Otherwise, find the NanoClaw remote hosting `skill/parallel-search`,
fetch that branch and merge it into the user's fork. With that remote named
`upstream`, run `git fetch upstream skill/parallel-search`, then
`git merge upstream/skill/parallel-search`.

Do not discard customizations when resolving conflicts. In particular, preserve
existing MCP servers, authentication, search permissions and disabled tools.

## 2. Choose search behavior

The resolver leaves existing SDK search routing in place when it finds saved MCP
servers, search permissions, MCP enable/disable settings or search API credentials.
It does not edit Claude's settings or replace saved server URLs or headers.
New installations without these settings use anonymous Parallel search.

Ask which behavior the user wants for each group:

- `parallel`: use Parallel search and fetch. Native `WebSearch` and `WebFetch`
  are excluded, so a failed request cannot silently switch to native search.
- `native`: retain the previous SDK behavior, including configured MCP servers.
  Use this to keep native search features that Parallel does not provide.
- `disabled`: exclude both native web tools and this skill's Parallel tools.
  This is a search-tool control, not a network sandbox for other tools.

To save an explicit choice, run
`node .claude/skills/add-parallel/scripts/configure-search.mjs GROUP PROVIDER`
from the NanoClaw root, replacing `GROUP` with the registered group folder and
`PROVIDER` with one of the choices above. For example, use `main parallel` for
the main group. This writes only that group's
`data/sessions/GROUP/.claude/nanoclaw-search.json`.

An advanced per-project choice in `/workspace/group/.claude/nanoclaw-search.json`
takes precedence over the group setting. A saved disable for `parallel-search`
remains authoritative. Leave existing permission rules intact; the SDK still
loads project and user settings.

For explicitly selected Parallel, an existing `parallel-search` MCP server keeps
its URL, headers and transport. If no server is saved, the skill uses the native
SDK HTTP transport to `https://search.parallel.ai/mcp`. An intentionally supplied
`PARALLEL_API_KEY` is used only when Parallel is explicitly selected. Do not collect
or print keys. Keep credentials in the user's existing credential gateway/setup.

## 3. Build and restart

Run `npm ci` and `npm test` in `container/agent-runner` to build and check the
runner. The tests use scripted model responses and a local MCP fixture; they do
not call a model service. This skill adds no runtime dependencies. Existing group
runner sources are refreshed on the next container start because `index.ts`
changed, then compiled by the image's existing entrypoint. No image rebuild is
needed for an already configured installation.

Restart the installed NanoClaw service using its platform's service manager.
Existing sessions and group memory are retained. Let active containers finish or
restart them before testing the new tools.

## 4. Verify through a conversation

Ask the assistant to find a current fact, then read one of its source URLs.
Check the container log for `Web search provider: parallel`, the
`mcp__parallel-search__web_search` and `mcp__parallel-search__web_fetch` calls,
and a useful answer with source URLs. A service-limit response is an error, not a
search result; the agent should report it. There is no automatic provider fallback.

If the log says `native`, inspect saved settings and credentials first. Do not
erase them to enable this skill; save an explicit provider choice instead.
If the log says `disabled`, check the provider choice and saved MCP disable list.
For connection failures, check the container's HTTPS connectivity and credential
gateway policy for `search.parallel.ai`.

## Revert the search choice

Save `native` with the configuration script to restore the previous SDK web tools
and stop adding the Parallel server. To disable this skill's search tools, save
`disabled`. Rebuild/restart only if removing the feature branch's code entirely.
