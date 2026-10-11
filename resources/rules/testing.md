<!-- dsh-adaptation -->
> **DSH Rule** — An always-follow guideline. Copy the rules you want into the project `AGENTS.md`, or load this file with @ when the task touches its subject.

# Testing Requirements

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** - Individual functions, utilities, components
2. **Integration Tests** - API endpoints, database operations
3. **E2E Tests** - Critical user flows (Playwright)

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## Troubleshooting Test Failures

1. tdd-guide persona (`resources/agents/tdd-guide.md`)
2. Check test isolation
3. Verify mocks are correct
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide persona (`resources/agents/tdd-guide.md`)** - Use PROACTIVELY for new features, enforces write-tests-first
- **e2e-runner persona (`resources/agents/e2e-runner.md`)** - Playwright E2E testing specialist
