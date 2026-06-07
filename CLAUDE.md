# CLAUDE.md

Project-level guidance for Claude Code working in this repository.

## Planning vs Implementation Workflow

Before starting any task, classify the request as one of the following modes,
and adopt the matching behavior. When a request spans modes (e.g. "design and
build X"), do the Planning portion first and only proceed to Implementation
once the plan is approved.

### 1. Planning / Architecture

Examples:

- Product requirements
- Architecture design
- Database schema design
- API design
- Security review
- Major refactor planning
- Technical tradeoff analysis
- Feature decomposition

Behavior:

- Focus on reasoning and decision quality.
- Challenge assumptions.
- Explore alternatives.
- Produce implementation-ready plans.
- Do not begin coding unless explicitly requested.

### 2. Implementation / Execution

Examples:

- Building approved features
- Creating components
- Writing tests
- Styling
- CRUD functionality
- Bug fixes
- Documentation updates

Behavior:

- Follow the approved architecture.
- Avoid redesigning previously approved systems.
- Minimize unnecessary analysis.
- Prioritize execution and completion.
- Escalate only if a major issue is discovered.

### 3. Review / Audit

Examples:

- Reviewing implementation reports
- Reviewing pull requests
- Auditing architecture decisions
- Evaluating completed work

Behavior:

- Identify risks.
- Identify deviations from approved plans.
- Recommend corrective actions.
- Avoid rewriting working implementations without strong justification.

## Architecture Freeze Rule

Once an implementation plan is approved, assume the architecture is frozen.

Do not redesign architecture during implementation unless:

- A security issue exists.
- A scalability issue prevents requirements from being met.
- A requirement cannot be implemented under the approved design.

Otherwise, implement the approved plan.

## Token Efficiency

- Prefer concise responses.
- Avoid repeating previously established context.
- Avoid re-explaining approved architecture.
- Reference existing decisions rather than restating them.
- During implementation, focus on the smallest amount of context necessary to
  complete the task.

## Session Discipline

- Assume planning and implementation may occur in separate Claude sessions.
- Implementation work should treat approved plans as the source of truth unless
  a critical issue is identified.
