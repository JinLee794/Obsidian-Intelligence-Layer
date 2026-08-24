---
name: oil-setup
description: 'Diagnose the Obsidian Intelligence Layer (OIL) MCP server when its tools are missing, erroring, or its optional Ollama semantic tier is not running. Trigger when oil tools do not appear at all, when a call returns "tool unavailable", when the vault path looks wrong, or when a user asks how to enable, disable, or configure semantic search.'
argument-hint: 'Describe the symptom: tools missing, wrong vault, or semantic tier off'
---

# OIL Setup and Diagnosis

**Scope note.** OIL's tools document themselves: descriptions say when to call
them, schemas explain each parameter, and failures return `agent_guidance` with
`next_step` and `suggested_tools`. Do not look here for which tool to call or how
to recover from an error — the tool surface already answers that, per tool, at
the moment it matters.

This skill covers only what the tool surface *cannot*: the states where the tools
are absent or degraded, and the fixes that live outside the vault, in the user's
shell and config.

## 1. When the `oil` tools are missing entirely

Symptoms: no `oil` tools in the tool list, or a call returns
`Tool 'get_health' is unavailable`.

**Do not report that as an answer.** It means the server process exited before
the client reached it, and the client surfaces no reason. There is no tool to ask
— diagnose it yourself with the shell. It is almost always the vault path, and it
is *never* caused by Ollama, which cannot prevent startup.

**Step 1 — is the variable set in the environment that launched the session?**

```powershell
$env:OBSIDIAN_VAULT_PATH             # Windows
```

```bash
echo "$OBSIDIAN_VAULT_PATH"          # macOS / Linux
```

Empty output is the diagnosis. The plugin's `.mcp.json` resolves
`${OBSIDIAN_VAULT_PATH}` at spawn time; unset means the server starts with no
vault and exits immediately. It must be an **absolute path to the folder holding
the notes** — not a note, not a relative path. Obsidian itself need not be
running.

**Step 2 — run the bundled diagnostic.** It resolves flags, environment and
`oil.config.yaml`, prints the *effective* settings, and exits non-zero when
something needs attention:

```bash
npx -y --package=github:JinLee794/Obsidian-Intelligence-Layer#v0.6.0 -- \
  obsidian-intelligence-layer doctor --vault=/absolute/path/to/vault
```

Keep the `#v` pin. Unpinned, `npx` resolves the default branch, which may predate
the `doctor` subcommand — you get "unknown command" and mistake a stale fetch for
a broken install.

**Step 3 — set it persistently, then restart.** MCP servers are spawned once, at
session start. Setting the variable inside the running session changes nothing;
say so explicitly rather than letting the user retry into the same failure.

```powershell
setx OBSIDIAN_VAULT_PATH "C:\path\to\vault"          # Windows, persistent
```

```bash
export OBSIDIAN_VAULT_PATH="/absolute/path/to/vault" # add to the shell profile
```

## 2. When the tools work but the semantic tier does not

Ollama is an optional local service, not a dependency. If it is absent,
`search_vault` serves its keyword tiers and nothing breaks — so **never report
OIL as down because Ollama is missing.** Name the degraded tier, not the server.

Call `get_health` and read `semantic`. It already carries `status`, the `reason`
it is not serving, and a `remedy` naming the fix — relay those rather than
guessing. (`remedy` is absent on servers older than v0.7.0; fall back to this
section.) `cold` and `indexing` are not faults: the tier embeds in the background
and needs no intervention.

Turning it **on** is just installing [Ollama](https://ollama.com) and leaving it
running — OIL pulls the embedding model itself on first use. Expect roughly
90–110 ms per note for the first index, in the background, persisted to
`_oil-vectors.json` so restarts re-embed nothing. Nothing leaves the machine; the
default endpoint is loopback.

Turning it **off**, in precedence order — flags beat environment beats file:

```bash
--no-semantic                     # flag on the server command
OIL_SEMANTIC=off                  # env var visible to the server process
semantic: { enabled: false }      # oil.config.yaml in the vault root
```

Model, endpoint and score floor follow the same precedence
(`OIL_SEMANTIC_MODEL` / `OIL_SEMANTIC_ENDPOINT` / `OIL_SEMANTIC_MIN_SCORE`, or
`semantic.model` / `.endpoint` / `.min_score`). Under the Copilot plugin prefer
`oil.config.yaml`: it lives in the vault and survives plugin updates, whereas
`.mcp.json` is regenerated. Changing the model changes the vector dimensions, so
the whole index is re-embedded — say so before suggesting it.

## Guardrails

1. Never answer "the tool is unavailable" and stop. That is a symptom; §1 finds
   the cause.
2. Never report OIL as broken because Ollama is missing, and never disable the
   semantic tier to "fix" an unrelated error.
3. Never claim vault data was sent anywhere — embeddings are computed locally.
4. Do not install Ollama unprompted; it is a ~1 GB native application. There is
   no OIL tool that installs anything, by design. Use the user's shell, where the
   install is visible and approvable.
5. Quote `reason`, `remedy` and `doctor` output as printed instead of
   paraphrasing them into a guess.
