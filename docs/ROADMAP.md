# Roadmap

## Project Goal

Build a Bun + Effect v4 CLI that turns OpenCode sessions into article-writing inputs.
The tool should let us select one or more sessions, extract the useful conversation,
remove tool and execution noise, and generate a high-quality prompt bundle for a
downstream writing agent.

## Current Status

### Done

- Verified how to access real OpenCode session data locally.
- Confirmed useful OpenCode CLI commands, especially session listing and export.
- Inspected real exported session structure and verified that messages contain mixed
  text, reasoning, tool calls, and step markers.
- Moved the project onto the newer Effect v4 beta package set.
- Switched the implementation to Bun-oriented Effect platform packages.
- Built a first working CLI with these commands:
  - `list`
  - `extract`
  - `prompt`
- Fixed Effect CLI runtime provisioning so the app typechecks and runs cleanly.
- Fixed SQLite layer lifetime handling so the database client is not closed before
  queries execute.
- Verified the current CLI end-to-end against real local session data.

### Working Now

- `bunx tsgo --noEmit`
- `bun run src/cli/main.ts list --limit 3`
- `bun run src/cli/main.ts extract <session-id>`
- `bun run src/cli/main.ts prompt <session-id> --json`

### Confirmed Behavior

- The extractor keeps user and assistant text turns.
- The extractor drops tool parts, reasoning parts, and step markers.
- The prompt composer produces a downstream writing prompt plus source metadata.
- Multi-session command input is already supported at the CLI argument level.

## Current Gaps

- Extracted text still contains some wrapper or routing instructions when they are
  embedded inside otherwise valid user text.
- Prompt composition is still fairly raw and does not yet restructure material into
  stronger article sections.
- Session selection is not interactive yet.
- AI summarization and article-drafting integration is not wired up yet.
- There are no automated tests yet.
- `README.md` still contains the default Bun starter text and should be rewritten.

## Next Steps

### Phase 1: Improve Extraction Quality

- Add cleanup heuristics for wrapper text such as routing blocks and meta-instructions.
- Normalize whitespace and repeated boilerplate.
- Decide whether to keep or drop low-value assistant boilerplate.
- Validate extraction quality on several different real sessions.

### Phase 2: Improve Prompt Composition

- Add a better prompt bundle structure for article drafting.
- Separate raw extracted material from editorial guidance.
- Add optional output formats such as plain prompt, JSON bundle, and markdown draft input.
- Verify that multi-session prompt output stays coherent.

### Phase 3: Improve UX

- Add interactive session selection.
- Add friendlier preview output for extracted turns and stats.
- Add filtering options such as recent sessions, directory, and session count.

### Phase 4: AI Integration

- Add configurable AI client wiring once `apiKey` and `apiUrl` are provided.
- Generate summaries, outlines, or first drafts from extracted session bundles.
- Compare raw prompt output with AI-assisted output to judge usefulness.

### Phase 5: Packaging and Reuse

- Turn the workflow into reusable scripts and/or a skill.
- Document the final workflow for repeated article generation.
- Add tests for extraction and prompt composition against saved fixtures.

## Immediate Priority

The next best move is to improve extraction quality by stripping wrapper/meta text
from preserved conversation turns, then test the result across multiple real sessions.
