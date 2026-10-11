<!-- dsh-adaptation -->
> **DSH Rule** — An always-follow guideline. Copy the rules you want into the project `AGENTS.md`, or load this file with @ when the task touches its subject.

# Agent Orchestration

## Available Agents

Located in `~/.dsh/agents/`:

| Agent | Purpose | When to Use |
|-------|---------|-------------|
| planner persona (`resources/agents/planner.md`) | Implementation planning | Complex features, refactoring |
| architect | System design | Architectural decisions |
| tdd-guide persona (`resources/agents/tdd-guide.md`) | Test-driven development | New features, bug fixes |
| code-reviewer persona (`resources/agents/code-reviewer.md`) | Code review | After writing code |
| security-reviewer persona (`resources/agents/security-reviewer.md`) | Security analysis | Before commits |
| build-error-resolver persona (`resources/agents/build-error-resolver.md`) | Fix build errors | When build fails |
| e2e-runner persona (`resources/agents/e2e-runner.md`) | E2E testing | Critical user flows |
| refactor-cleaner persona (`resources/agents/refactor-cleaner.md`) | Dead code cleanup | Code maintenance |
| doc-updater persona (`resources/agents/doc-updater.md`) | Documentation | Updating docs |

## Immediate Agent Usage

No user prompt needed:
1. Complex feature requests - planner persona (`resources/agents/planner.md`)
2. Code just written/modified - code-reviewer persona (`resources/agents/code-reviewer.md`)
3. Bug fix or new feature - tdd-guide persona (`resources/agents/tdd-guide.md`)
4. Architectural decision - Use **architect** agent

## Parallel Task Execution

ALWAYS use parallel Task execution for independent operations:

```markdown
# GOOD: Parallel execution
Launch 3 agents in parallel:
1. Agent 1: Security analysis of auth.ts
2. Agent 2: Performance review of cache system
3. Agent 3: Type checking of utils.ts

# BAD: Sequential when unnecessary
First agent 1, then agent 2, then agent 3
```

## Multi-Perspective Analysis

For complex problems, use split role sub-agents:
- Factual reviewer
- Senior engineer
- Security expert
- Consistency reviewer
- Redundancy checker
