---
name: ecc-checkpoint
description: Create or verify a checkpoint in your workflow.
# generated-by: scripts/build-ecc-skills.mjs
---

# Checkpoint Command

> Invoke with `/ecc-checkpoint` to apply this workflow, or load it with the `skill` tool.

Create or verify a checkpoint in your workflow.

## Usage

follow `resources/commands/checkpoint.md` with `[create|verify|list] [name]`

## Create Checkpoint

When creating a checkpoint:

1. Run follow `resources/commands/verify.md` with `quick` to ensure current state is clean
2. Create a git stash or commit with checkpoint name
3. Log checkpoint to `.dsh/checkpoints.log`:

```bash
echo "$(date +%Y-%m-%d-%H:%M) | $CHECKPOINT_NAME | $(git rev-parse --short HEAD)" >> .dsh/checkpoints.log
```

4. Report checkpoint created

## Verify Checkpoint

When verifying against a checkpoint:

1. Read checkpoint from log
2. Compare current state to checkpoint:
   - Files added since checkpoint
   - Files modified since checkpoint
   - Test pass rate now vs then
   - Coverage now vs then

3. Report:
```
CHECKPOINT COMPARISON: $NAME
============================
Files changed: X
Tests: +Y passed / -Z failed
Coverage: +X% / -Y%
Build: [PASS/FAIL]
```

## List Checkpoints

Show all checkpoints with:
- Name
- Timestamp
- Git SHA
- Status (current, behind, ahead)

## Workflow

Typical checkpoint flow:

```
[Start] --> follow `resources/commands/checkpoint.md` with `create "feature-start"`
   |
[Implement] --> follow `resources/commands/checkpoint.md` with `create "core-done"`
   |
[Test] --> follow `resources/commands/checkpoint.md` with `verify "core-done"`
   |
[Refactor] --> follow `resources/commands/checkpoint.md` with `create "refactor-done"`
   |
[PR] --> follow `resources/commands/checkpoint.md` with `verify "feature-start"`
```

## Arguments

$ARGUMENTS:
- `create <name>` - Create named checkpoint
- `verify <name>` - Verify against named checkpoint
- `list` - Show all checkpoints
- `clear` - Remove old checkpoints (keeps last 5)
