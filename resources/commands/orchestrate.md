<!-- dsh-adaptation -->
> **DSH Prompt** — In DSH this file was a slash command. DSH resolves `/name` through the human-command registry, which never reaches the model, so this is a prompt instead: paste it, or reference the file with @, and the agent follows it as instructions. Its tool names have been mapped to DSH tools.

# Orchestrate Command

Sequential agent workflow for complex tasks.

## Usage

follow `resources/commands/orchestrate.md` with `[workflow-type] [task-description]`

## Workflow Types

### feature
Full feature implementation workflow:
```
planner persona (`resources/agents/planner.md`) -> tdd-guide persona (`resources/agents/tdd-guide.md`) -> code-reviewer persona (`resources/agents/code-reviewer.md`) -> security-reviewer persona (`resources/agents/security-reviewer.md`)
```

### bugfix
Bug investigation and fix workflow:
```
explorer -> tdd-guide persona (`resources/agents/tdd-guide.md`) -> code-reviewer persona (`resources/agents/code-reviewer.md`)
```

### refactor
Safe refactoring workflow:
```
architect -> code-reviewer persona (`resources/agents/code-reviewer.md`) -> tdd-guide persona (`resources/agents/tdd-guide.md`)
```

### security
Security-focused review:
```
security-reviewer persona (`resources/agents/security-reviewer.md`) -> code-reviewer persona (`resources/agents/code-reviewer.md`) -> architect
```

## Execution Pattern

For each agent in the workflow:

1. **Invoke agent** with context from previous agent
2. **Collect output** as structured handoff document
3. **Pass to next agent** in chain
4. **Aggregate results** into final report

## Handoff Document Format

Between agents, create handoff document:

```markdown
## HANDOFF: [previous-agent] -> [next-agent]

### Context
[Summary of what was done]

### Findings
[Key discoveries or decisions]

### Files Modified
[List of files touched]

### Open Questions
[Unresolved items for next agent]

### Recommendations
[Suggested next steps]
```

## Example: Feature Workflow

```
follow `resources/commands/orchestrate.md` with `feature "Add user authentication"`
```

Executes:

1. **Planner Agent**
   - Analyzes requirements
   - Creates implementation plan
   - Identifies dependencies
   - Output: `HANDOFF: planner persona (`resources/agents/planner.md`) -> tdd-guide persona (`resources/agents/tdd-guide.md`)`

2. **TDD Guide Agent**
   - Reads planner persona (`resources/agents/planner.md`) handoff
   - Writes tests first
   - Implements to pass tests
   - Output: `HANDOFF: tdd-guide persona (`resources/agents/tdd-guide.md`) -> code-reviewer persona (`resources/agents/code-reviewer.md`)`

3. **Code Reviewer Agent**
   - Reviews implementation
   - Checks for issues
   - Suggests improvements
   - Output: `HANDOFF: code-reviewer persona (`resources/agents/code-reviewer.md`) -> security-reviewer persona (`resources/agents/security-reviewer.md`)`

4. **Security Reviewer Agent**
   - Security audit
   - Vulnerability check
   - Final approval
   - Output: Final Report

## Final Report Format

```
ORCHESTRATION REPORT
====================
Workflow: feature
Task: Add user authentication
Agents: planner persona (`resources/agents/planner.md`) -> tdd-guide persona (`resources/agents/tdd-guide.md`) -> code-reviewer persona (`resources/agents/code-reviewer.md`) -> security-reviewer persona (`resources/agents/security-reviewer.md`)

SUMMARY
-------
[One paragraph summary]

AGENT OUTPUTS
-------------
Planner: [summary]
TDD Guide: [summary]
Code Reviewer: [summary]
Security Reviewer: [summary]

FILES CHANGED
-------------
[List all files modified]

TEST RESULTS
------------
[Test pass/fail summary]

SECURITY STATUS
---------------
[Security findings]

RECOMMENDATION
--------------
[SHIP / NEEDS WORK / BLOCKED]
```

## Parallel Execution

For independent checks, run agents in parallel:

```markdown
### Parallel Phase
Run simultaneously:
- code-reviewer persona (`resources/agents/code-reviewer.md`) (quality)
- security-reviewer persona (`resources/agents/security-reviewer.md`) (security)
- architect (design)

### Merge Results
Combine outputs into single report
```

## Arguments

$ARGUMENTS:
- `feature <description>` - Full feature workflow
- `bugfix <description>` - Bug fix workflow
- `refactor <description>` - Refactoring workflow
- `security <description>` - Security review workflow
- `custom <agents> <description>` - Custom agent sequence

## Custom Workflow Example

```
follow `resources/commands/orchestrate.md` with `custom "architect,tdd-guide persona (`resources/agents/tdd-guide.md`),code-reviewer persona (`resources/agents/code-reviewer.md`)" "Redesign caching layer"`
```

## Tips

1. **Start with planner persona (`resources/agents/planner.md`)** for complex features
2. **Always include code-reviewer persona (`resources/agents/code-reviewer.md`)** before merge
3. **Use security-reviewer persona (`resources/agents/security-reviewer.md`)** for auth/payment/PII
4. **Keep handoffs concise** - focus on what next agent needs
5. **Run verification** between agents if needed
