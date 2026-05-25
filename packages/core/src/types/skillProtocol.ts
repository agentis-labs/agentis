/**
 * Behavioral skill protocols (WORKFLOW-10X-MASTERPLAN §2.5).
 *
 * A *skill* is a markdown file that teaches any agent HOW to approach a class of
 * task (a framework, checklist, or cognitive rubric) — distinct from an agent,
 * which defines WHO does the work. The same `coder` agent loaded with
 * `tdd-protocol` enforces TDD; loaded with `owasp-checklist` it enforces security
 * review. Skills are stored as `.md` files in the Workspace Volume's `skills/`
 * directory and injected into the agent prompt at dispatch.
 */

export interface SkillProtocol {
  name: string;
  version: string;
  /** Agent roles this skill is most applicable to (advisory). */
  applicableTo: string[];
  tags: string[];
  /** The markdown body — the actual behavioral instructions injected at dispatch. */
  body: string;
}

const skill = (name: string, version: string, applicableTo: string[], tags: string[], body: string): SkillProtocol =>
  ({ name, version, applicableTo, tags, body: body.trim() });

export const PLATFORM_SKILLS: readonly SkillProtocol[] = [
  skill('tdd-protocol', '1.0.0', ['coder', 'debugger'], ['coding', 'testing'], `
# Test-Driven Development Protocol
When implementing any feature:
1. Write the failing test first — assert the desired behavior before any implementation.
2. Write the minimum implementation to make the test pass.
3. Refactor only after green. Never ship code without a test that would catch its regression.`),

  skill('owasp-checklist', '1.0.0', ['reviewer', 'coder'], ['security'], `
# OWASP Top 10 Review Checklist
Before approving code, check for: injection (SQL/command/template), broken auth/session,
sensitive data exposure, XXE, broken access control, security misconfiguration, XSS,
insecure deserialization, vulnerable dependencies, insufficient logging. Flag each finding
as blocking or non-blocking with a file/line reference.`),

  skill('aarrr-framework', '1.0.0', ['analyst', 'writer', 'researcher'], ['product', 'growth'], `
# AARRR Analysis Framework
Structure any product/business-metric analysis in this order:
1. Acquisition — how users find the product (CAC, channel mix).
2. Activation — first-experience quality (onboarding completion, time-to-value).
3. Retention — are they coming back (DAU/MAU, churn, cohort curves).
4. Revenue — monetization (ARPU, LTV, payback period).
5. Referral — are users referring others (NPS, viral coefficient).`),

  skill('statistical-testing', '1.0.0', ['analyst'], ['data', 'analytics'], `
# Statistical Testing Guidelines
State the hypothesis and the null. Report the test used, the sample size, the effect size,
and the p-value or confidence interval. Never claim significance without n and a stated
threshold. Call out confounders and whether the comparison is paired or independent.`),

  skill('adr-format', '1.0.0', ['architect'], ['architecture'], `
# Architecture Decision Record Format
Write each decision as: Title; Date; Status (Proposed/Active/Superseded); Context (the forces
at play); Decision (what we chose); Rationale; Consequences (trade-offs accepted); Rejected
alternatives. Keep it to one screen.`),

  skill('code-review-rubric', '1.0.0', ['reviewer'], ['review'], `
# Code Review Rubric
Review in this order and separate blocking from non-blocking: 1) Correctness — does it do
what it claims; 2) Tests — do they cover the change and its failure modes; 3) Security —
run the OWASP checklist; 4) Conventions — does it match the workspace stack/rules;
5) Clarity — naming, comments-where-needed, no dead code.`),

  skill('api-design-guidelines', '1.0.0', ['coder', 'architect'], ['coding', 'api'], `
# REST API Design Principles
Resource-oriented nouns, not verbs. Use the right status codes (201 create, 422 validation,
409 conflict). Version at the boundary. Make errors machine-readable with a stable code +
human message. Idempotent PUT/DELETE. Paginate list endpoints. Never break a shipped contract.`),
];

export function skillByName(name: string): SkillProtocol | undefined {
  return PLATFORM_SKILLS.find((s) => s.name === name);
}
