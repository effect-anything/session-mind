# @effect-x/session-mind

Node-first CLI for inspecting OpenCode, Codex, and Claude sessions and turning them into reusable writing workflows.

## Highlights

- lists recent sessions across supported providers with a consistent identifier format
- extracts normalized conversations for downstream prompts, summaries, and article generation
- runs article-writing workflows that manage drafts, review loops, and publish transitions
- bundles a Node CLI with `tsdown` while keeping Bun as the repository package manager and local runner
- ships with a single-package Changesets workflow for npm publishing

## Install

Run it without installing:

```bash
npx @effect-x/session-mind --help
```

Or install it globally:

```bash
npm install --global @effect-x/session-mind
session-mind --help
```

## Usage

List recent sessions:

```bash
session-mind list --limit 10
```

Extract one or more sessions:

```bash
session-mind extract opencode:session-123 codex:session-456
```

Build a writing workflow from the latest session:

```bash
session-mind write --latest
```

Inspect article state for a session:

```bash
session-mind article status opencode:session-123
```

## Development

The repository uses Bun for dependency management and local commands. The published CLI targets Node.js 24+.

```bash
bun install
bun run check
node ./dist/cli.js --help
```

## Release

This package uses Changesets plus the shared GitHub Actions release workflow.

```bash
bun run changeset
bun run version-packages
bun run release
```

## License

MIT
