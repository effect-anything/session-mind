## Project Introduction

`session-mind` is a Bun + Effect v4 CLI project for turning OpenCode session
history into useful article-writing input.

The core idea is simple:

- read one or more real OpenCode sessions from local storage
- keep the meaningful user and assistant conversation
- drop tool calls, reasoning traces, step markers, and similar noise
- generate a structured prompt bundle for a downstream writing agent

# Information

- Run commands from the monorepo root.
- The package manager used is `bun`.
- Avoid `index.ts` barrel files;

## Structure

- `.repo/`: reference repositories
- `src/`: main files
- `docs/`: project documentation

## Working Loop

1. Identify the target app or package.
2. Follow local patterns in that directory.
3. Run focused checks/tests for the target.

## Quick Commands

```bash
bun run check (typecheck, lint, formatter, test)
bun run build
```

# Specifications

To learn more about previous and current specifications for this project, see
the `.specs/README.md` file.

# Learning more about the "effect" & "@effect/\*" packages

`.repo/effect/README.md` is an authoritative source of information about the
"effect" and "@effect/\*" packages. Read this before looking elsewhere for
information about these packages. It contains the best practices for using
effect.

Use this for learning more about the library, rather than browsing the code in
`node_modules/`.

## Engineering Principles

- **Proactive Progress**: Don't wait for instructions. Identify blockers, propose solutions, and push work forward autonomously.
- **Robust & Scalable**: Prefer solutions that work reliably and can grow. Avoid fragile hacks that break under load.
- **Globally Optimal**: Consider the whole system, not just the immediate fix. Trade-offs should be conscious and documented.
- **Verify Reality**: Test assumptions. A working demo beats a perfect plan.
- **Ship & Iterate**: Perfect is the enemy of done. Get to working state, then improve.
