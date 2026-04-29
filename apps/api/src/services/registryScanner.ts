/**
 * Registry install security scanner — V1-SPEC §9.2.
 *
 * Runs after SHA-256 verification but before `installed_registry_artifacts`
 * insert. The scanner inspects the artifact bytes for two classes of
 * supply-chain issues:
 *
 *   1. Prompt-injection markers — strings observed in the wild as
 *      jailbreak directives targeting LLM-driven agents. A hit does not
 *      auto-block; it is bubbled up as a `findings` warning the operator
 *      must acknowledge alongside the existing permission summary.
 *
 *   2. Hard-coded secrets — common cloud keys, GitHub tokens, generic
 *      private keys, JWTs. These are auto-blocked because no legitimate
 *      registry artifact should ship a secret in plaintext.
 *
 * The scanner is intentionally regex-based and trust-aware: false positives
 * are surfaced as warnings rather than refusals when the pattern is
 * ambiguous (e.g. a generic-looking high-entropy string that may be a UUID).
 */

import { AgentisError } from '@agentis/core';

export type ScanSeverity = 'block' | 'warn';

export interface ScanFinding {
  severity: ScanSeverity;
  rule: string;
  detail: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

const SECRET_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { rule: 'aws-secret-key', re: /aws_secret_access_key\s*[:=]\s*['"][A-Za-z0-9/+=]{40}['"]/i },
  { rule: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { rule: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { rule: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { rule: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { rule: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
];

const INJECTION_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'ignore-previous', re: /\bignore (?:all |the )?(?:previous|prior|above) (?:instructions?|prompts?|rules?)\b/i },
  { rule: 'override-system', re: /\b(?:override|disregard|forget) (?:the )?system (?:prompt|message|instructions?)\b/i },
  { rule: 'jailbreak-persona', re: /\byou are (?:now )?(?:dan|jailbroken|unrestricted)\b/i },
  { rule: 'hidden-tool-call', re: /<\|tool_call\|>|<tool_use[^>]*>/i },
  { rule: 'role-impersonation', re: /\bact as (?:the )?(?:system|root|administrator|developer)\b/i },
  { rule: 'data-exfil-directive', re: /\b(?:exfiltrate|leak|send) (?:the )?(?:credentials?|secrets?|api[_ ]?key|env(?:ironment)? variables?)\b/i },
];

export function scanArtifactBytes(buf: Buffer, label: string): ScanResult {
  const MAX_SCAN_BYTES = 8 * 1024 * 1024;
  const slice = buf.length > MAX_SCAN_BYTES ? buf.subarray(0, MAX_SCAN_BYTES) : buf;
  const text = slice.toString('utf8');

  const findings: ScanFinding[] = [];

  for (const { rule, re } of SECRET_PATTERNS) {
    if (re.test(text)) {
      findings.push({ severity: 'block', rule, detail: `${label}: matched ${rule}` });
    }
  }
  for (const { rule, re } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      findings.push({ severity: 'warn', rule, detail: `${label}: matched ${rule}` });
    }
  }

  const ok = !findings.some((f) => f.severity === 'block');
  return { ok, findings };
}

/**
 * Throws `SKILL_REGISTRY_SCAN_BLOCKED` when any rule has severity `block`.
 * Warnings are returned to the caller so the route handler can include
 * them in the install response and surface them in the dashboard
 * permission summary.
 */
export function assertNoBlockingFindings(result: ScanResult): ScanFinding[] {
  const blockers = result.findings.filter((f) => f.severity === 'block');
  if (blockers.length > 0) {
    throw new AgentisError(
      'SKILL_REGISTRY_SCAN_BLOCKED',
      `Skill registry install blocked by security scan: ${blockers.map((b) => b.rule).join(', ')}`,
    );
  }
  return result.findings.filter((f) => f.severity === 'warn');
}
