# `obsidian-intelligence-layer` — Copilot plugin

One-command install of the [Obsidian Intelligence Layer](https://github.com/JinLee794/Obsidian-Intelligence-Layer)
MCP server, plus the two skills that tell an agent how to drive it.

## What the plugin contains

| Component | Name | Purpose |
|---|---|---|
| MCP server | `oil` | 15 tools over an Obsidian vault: tiered search, graph traversal, mtime-guarded writes, audit log |
| Skill | `oil-setup` | Diagnosing a server that did not start, and the optional Ollama tier |

**One skill, deliberately.** The tools already document themselves — descriptions
say when to call them, parameter schemas explain each option, and a failed write
returns `agent_guidance.next_step` naming the exact recovery sequence. A skill
restating any of that would cost context to say something twice, and could drift
out of sync with it. `oil-setup` covers only what tool discovery cannot reach:
the states where there are no tools to consult, and the fixes that live in your
shell rather than in the vault.

## Install

```bash
copilot plugin marketplace add JinLee794/Obsidian-Intelligence-Layer
copilot plugin install obsidian-intelligence-layer@oil-marketplace
```

Or install the plugin directly, without registering the marketplace:

```bash
copilot plugin install JinLee794/Obsidian-Intelligence-Layer:plugins/obsidian-intelligence-layer
```

## Required configuration

The plugin's MCP server reads **`OBSIDIAN_VAULT_PATH`** from your environment.
Set it to the absolute path of your vault before starting a session — Obsidian
itself does not need to be running.

```powershell
# Windows (persistent)
setx OBSIDIAN_VAULT_PATH "C:\path\to\your\vault"
```

```bash
# macOS / Linux — add to your shell profile
export OBSIDIAN_VAULT_PATH="/absolute/path/to/your/vault"
```

Verify before opening a session:

```bash
npx -y --package=github:JinLee794/Obsidian-Intelligence-Layer#v0.6.0 -- \
  obsidian-intelligence-layer doctor --vault="$OBSIDIAN_VAULT_PATH"
```

Keep the `#v...` pin: without it `npx` resolves the default branch, which may not
carry the `doctor` subcommand yet.

> MCP servers are spawned once, at session start. Setting
> `OBSIDIAN_VAULT_PATH` inside a running session does nothing — restart the
> terminal and the session after changing it.

## The Ollama dependency is optional

OIL's fourth search tier embeds notes locally through [Ollama](https://ollama.com)
so `search_vault` can answer questions phrased in words the notes never use.

**It is not required, and it is not bundled.** Ollama is a native ~1 GB
application; pulling it from an npm `postinstall` would add a native build step
and break installs for everyone who does not want it. So OIL ships zero native
dependencies and discovers Ollama at runtime:

| State | Effect |
|---|---|
| Ollama not installed or not running | Semantic tier reports `unavailable`; `search_vault` serves the keyword tiers. **Nothing errors.** |
| Ollama running, model missing | OIL pulls `nomic-embed-text` over Ollama's HTTP API on first use, in the background |
| Ollama running, model present | Vectors build in the background and persist to `_oil-vectors.json` in the vault |
| Not wanted at all | Set `OIL_SEMANTIC=off` in your environment |

Nothing leaves the machine: the default endpoint is `127.0.0.1:11434`.

To turn it on:

```bash
ollama serve                    # if not already running as a service
ollama pull nomic-embed-text    # optional — OIL pulls it itself on first use
```

Ask the agent for `get_health` at any point; `semantic.status` is one of
`disabled`, `cold`, `indexing`, `ready`, or `unavailable`, with a `reason` for
the last two and a `remedy` naming the fix.

There is no `setup` tool, by design: installing Ollama is a ~1 GB native install
that belongs to you and your shell's approval flow, not to a tool an LLM can
decide to call. OIL reports what is wrong and what fixes it.

## Tuning the tier

The plugin's `.mcp.json` deliberately references **one** variable,
`OBSIDIAN_VAULT_PATH`. Everything else lives in `oil.config.yaml` in your vault
root, which survives plugin updates and needs no environment plumbing:

```yaml
semantic:
  enabled: true                        # false disables the tier outright
  endpoint: "http://127.0.0.1:11434"   # Ollama base URL (loopback)
  model: "nomic-embed-text"            # pulled automatically on first run
  min_score: 0.5                       # cosine floor for a hit
  timeout_ms: 15000
```

Changing `model` changes the vector dimensions, so `_oil-vectors.json` is
re-embedded from scratch.

The equivalent environment variables — `OIL_SEMANTIC`, `OIL_SEMANTIC_MODEL`,
`OIL_SEMANTIC_ENDPOINT`, `OIL_SEMANTIC_MIN_SCORE`, `OIL_EXCLUDE_FOLDERS` — still
win over the YAML when the server process can see them, and remain the right
mechanism for a hand-written `mcp-config.json`. Under the plugin, prefer the
YAML.

## Pinning

`.mcp.json` pins the server to a release tag so installs are reproducible:

```
npx -y --package=github:JinLee794/Obsidian-Intelligence-Layer#v0.6.0 -- obsidian-intelligence-layer mcp
```

The pin, `plugin.json`'s `version`, and the marketplace entry are all asserted
against each other by `src/__tests__/plugin-manifest.test.ts`, which also refuses
a prerelease pin — `v0.7.0-beta.1` was advertised by the marketplace and then
deleted from the remote, which breaks `npx` for every user. The pin deliberately
tracks the **released** server, not the version in `package.json`, which runs
ahead of it.

### Why the pin names the public repository

This plugin is mirrored to a private org repository, `mcaps-microsoft/Obsidian-Intelligence-Layer`,
whose `v0.6.0` tag is the *same commit* as the public one. The pin still names
the public `JinLee794` repo, on purpose.

An MCP server is spawned non-interactively, at session start. Fetching it from a
private repository makes that spawn depend on the user's git credentials being
present and valid at that moment — and when they are not, `npx` fails, the server
never starts, and the client reports only "tool unavailable" with no reason. That
is the single worst failure mode this plugin has, and it is the one the
`oil-setup` skill exists to untangle. A public pin cannot hit it.

Everyone who can reach the private marketplace can also reach the public
repository, so the public pin costs that audience nothing and removes an entire
class of startup failure.

To keep the fetch inside the org anyway — a reasonable call if the public
repository is not considered a durable dependency — change the one line in
`.mcp.json`:

```diff
- "--package=github:JinLee794/Obsidian-Intelligence-Layer#v0.6.0",
+ "--package=github:mcaps-microsoft/Obsidian-Intelligence-Layer#v0.6.0",
```

and confirm that every consumer has git credentials for the org available to
non-interactive processes.
