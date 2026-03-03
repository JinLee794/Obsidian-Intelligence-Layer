---
name: skill-authoring-best-practices
description: 'Audit, optimize, or create agent skills using Anthropic best practices. Use when reviewing existing skills for quality, writing new SKILL.md files, or finetuning skill descriptions, structure, and progressive disclosure patterns.'
argument-hint: 'Provide the skill file path to audit, or describe the new skill to create'
---

# Skill Authoring Best Practices

## Purpose
Evaluate and improve agent skill files using principles from Anthropic's skill authoring guide. Use this skill to audit existing `.github/skills/*/SKILL.md` files, create new skills, or refine skill metadata for better discovery and token efficiency.

## When to Use
- Creating a new SKILL.md from scratch.
- Auditing an existing skill for quality, conciseness, or structure.
- Skill is not being discovered/triggered as expected (description tuning).
- Skill output quality is inconsistent across models (freedom calibration).
- Refactoring a large skill into progressive-disclosure structure.

## Audit Checklist

Run through each item when reviewing a skill. Flag violations explicitly.

### Metadata Quality
- [ ] `name`: ≤64 chars, lowercase + hyphens only, no reserved words (`anthropic`, `claude`).
- [ ] `description`: non-empty, ≤1024 chars, written in **third person**.
- [ ] Description states **what** the skill does AND **when** to use it (trigger phrases).
- [ ] Description includes specific key terms users would say (not vague like "helps with documents").

### Conciseness
- [ ] SKILL.md body is **under 500 lines**. If over, split into referenced files.
- [ ] Only context the model does *not* already know is included.
- [ ] No verbose explanations of well-known concepts (PDFs, HTTP, JSON, etc.).
- [ ] Challenge every paragraph: "Does this justify its token cost?"

### Degrees of Freedom
Match specificity to task fragility:

| Freedom | When | Style |
|---------|------|-------|
| **High** | Multiple valid approaches, context-dependent | Text instructions, heuristics |
| **Medium** | Preferred pattern exists, some variation OK | Pseudocode, parameterized templates |
| **Low** | Fragile/error-prone, consistency critical | Exact scripts, no modification allowed |

- [ ] Each workflow section uses the appropriate freedom level.
- [ ] Fragile operations (migrations, bulk writes) have low-freedom guardrails.

### Progressive Disclosure
- [ ] SKILL.md is the overview/TOC; detailed content lives in separate files.
- [ ] References are **one level deep** from SKILL.md (no `a.md → b.md → c.md` chains).
- [ ] Referenced files are named descriptively (`form_validation_rules.md`, not `doc2.md`).
- [ ] Reference files >100 lines have a table of contents at the top.

### Terminology & Content
- [ ] Consistent terminology throughout (pick one term, use it everywhere).
- [ ] No time-sensitive information (no "before August 2025" conditionals).
- [ ] Deprecated patterns go in an "Old patterns" collapsible section if kept at all.
- [ ] Uses forward slashes in all file paths (never backslashes).
- [ ] Does not present multiple tool/library options without a clear default.

### Workflows & Feedback Loops
- [ ] Complex multi-step operations have numbered steps.
- [ ] Critical workflows include a copyable checklist for progress tracking.
- [ ] Validation/feedback loops exist for quality-critical tasks (run → check → fix → repeat).
- [ ] Decision points use conditional workflow pattern (determine type → follow branch).

### MCP Tool References
- [ ] MCP tools use fully qualified names: `ServerName:tool_name`.
- [ ] Dependencies/packages are explicitly listed, not assumed available.

## Creating a New Skill

### Step 1: Identify the Pattern
Complete the task manually with the agent first. Note what context you repeatedly provide — that's the skill content.

### Step 2: Write Metadata
```yaml
---
name: <lowercase-hyphenated-gerund-or-noun> # e.g., processing-pdfs, milestone-hygiene
description: '<What it does>. <When to trigger it — include specific phrases/terms users would say>.'
argument-hint: '<What to pass when invoking>'
---
```

Naming conventions (prefer gerund form):
- Good: `processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`
- Acceptable: `pdf-processing`, `spreadsheet-analysis`
- Avoid: `helper`, `utils`, `tools`, `documents`

### Step 3: Write Body
1. Start with `## Purpose` (1–2 sentences).
2. Add `## When to Use` (bullet list of trigger scenarios).
3. Add `## Runtime Contract` if MCP tools are involved.
4. Core instructions — use appropriate freedom level.
5. Reference files for detailed/domain content.
6. End with workflow steps if the skill drives a multi-step process.

### Step 4: Validate
- Body < 500 lines?
- Description third-person and specific?
- References one level deep?
- Tested with a real request?

## Optimizing Existing Skills

### Description Tuning
The description is the single most important field — it drives skill selection from 100+ candidates.

Effective pattern:
```
'<Action verb phrase>. Use when <trigger conditions with specific terms>.'
```

Examples:
- `'Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.'`
- `'Generates descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.'`

Anti-patterns:
- `'Helps with documents'` — too vague.
- `'I can help you process Excel files'` — wrong person (use third person).
- `'You can use this to...'` — wrong person.

### Token Reduction
1. Remove explanations of concepts the model already knows.
2. Replace prose with structured tables or bullet lists.
3. Move detailed reference material to separate files.
4. Replace inline code examples with utility scripts (executed, not loaded into context).

### Structure Refactoring
If a skill file exceeds 500 lines:
```
skill-name/
├── SKILL.md              # Overview + navigation (< 500 lines)
├── reference/
│   ├── domain-a.md       # Domain-specific details
│   └── domain-b.md       # Domain-specific details
├── examples.md           # Usage examples
└── scripts/              # Executable utilities
    └── validate.py
```

## Iterative Improvement Process

1. **Use the skill on real tasks** — not synthetic test cases.
2. **Observe behavior** — note where the agent struggles, skips steps, or makes wrong choices.
3. **Diagnose** — is the issue discovery (description), instruction clarity, or missing context?
4. **Refine** — make targeted edits, don't rewrite wholesale.
5. **Retest** — verify the fix on the original failing case AND existing passing cases.
6. **Repeat** — each cycle improves based on observed behavior, not assumptions.

## Anti-Patterns Reference

| Anti-Pattern | Fix |
|---|---|
| Vague description | Add specific trigger terms and action verbs |
| First/second person description | Rewrite in third person |
| Body > 500 lines | Split into SKILL.md + reference files |
| Deeply nested references | Flatten to one level from SKILL.md |
| Multiple options without default | Pick a default, mention alternative as escape hatch |
| Time-sensitive conditionals | Use "Current method" + "Old patterns" sections |
| Magic constants in scripts | Add comments justifying each value |
| Windows-style paths | Use forward slashes everywhere |
| Assuming tools/packages installed | Explicitly list dependencies |
| Unqualified MCP tool names | Use `ServerName:tool_name` format |
