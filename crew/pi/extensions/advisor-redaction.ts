// --- delta redaction --------------------------------------------------------
// High-signal shapes only, each named. The bias is deliberately toward
// UNDER-redacting: the advisor's whole value is grounded, specific advice, and a
// delta scrubbed into mush produces confident advice about nothing — a failure
// that is invisible, unlike a miss. A shape that would plausibly match ordinary
// source code is left out, and each omission is stated where it is made.
const redactionPlaceholder = (kind) => `<redacted:${kind}>`

// A value only counts as a credential when it mixes a digit and an upper-case
// letter. Measured over this checkout, that one requirement is the difference
// between redacting a single planted fixture secret and also redacting
// `payloadKey: 'advisor_unavailable'` and `const UNKNOWN_KEY = 'unknown-key'`,
// which are ordinary code. An all-lowercase secret is under-redacted on purpose.
const CREDENTIAL_VALUE_STRENGTH = /(?=.*[0-9])(?=.*[A-Z])/

// Order is meaning: the first shape that recognises a run of text owns it, so a
// token inside an Authorization header is reported as the header and counted
// once. No value class admits `<`, so a placeholder already written cannot be
// re-matched by a later rule.
const REDACTION_RULES = Object.freeze([
  // A PEM private key block, BEGIN line through its END line. Nothing in
  // ordinary source carries one, and the block is matched whole so no fragment
  // of the key body survives.
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:[A-Z][A-Z ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z][A-Z ]*)?PRIVATE KEY-----/g,
    render: () => redactionPlaceholder('private-key'),
  },
  // An Authorization header value. The header NAME is kept so the shape stays
  // legible to the model; only the credential after the colon is removed.
  {
    kind: 'authorization',
    pattern: /(Authorization\s*:\s*)([^\r\n<]+)/gi,
    render: (m) => `${m[1]}${redactionPlaceholder('authorization')}`,
  },
  // A bearer credential anywhere else. The `Bearer ` marker is unambiguous and
  // ordinary source does not carry a 12-character opaque run behind it.
  {
    kind: 'bearer-token',
    pattern: /(Bearer\s+)([A-Za-z0-9._~+\/=-]{12,})/gi,
    render: (m) => `${m[1]}${redactionPlaceholder('bearer-token')}`,
  },
  // An assignment to a name containing KEY, TOKEN, SECRET, PASSWORD, PASSWD or
  // CREDENTIAL whose value is a quoted literal — the env-var, JSON-field and
  // `k = v` forms all reduce to this one shape. The strength requirement above
  // is what keeps ordinary constants out.
  {
    kind: 'credential',
    pattern: /((?:^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_-]*\s*[:=]\s*)(["'`])([A-Za-z0-9_.\/+=~-]{16,})\2/gi,
    strong: 3,
    render: (m) => `${m[1]}${m[2]}${redactionPlaceholder('credential')}${m[2]}`,
  },
  // The same assignment unquoted, which is the dotenv and shell-export form.
  {
    kind: 'credential',
    pattern: /((?:^|\s)[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*=)([A-Za-z0-9_.\/+=~-]{16,})/gi,
    strong: 2,
    render: (m) => `${m[1]}${redactionPlaceholder('credential')}`,
  },
  // A JWT: three base64url segments whose FIRST is anchored to `eyJ`, the
  // base64url of `{"`. The generic three-segment form is deliberately not used —
  // it matches ordinary dotted code such as `a.b.c` — so a JWT whose header is
  // not JSON is under-redacted on purpose.
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    render: () => redactionPlaceholder('jwt'),
  },
  // GitHub's own documented token prefixes plus their opaque body. Nothing in
  // source starts a 20-character alphanumeric run with `ghp_`.
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    render: () => redactionPlaceholder('github-token'),
  },
  // OpenAI-style keys: the `sk-` prefix and at least 16 opaque characters.
  {
    kind: 'openai-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    render: () => redactionPlaceholder('openai-key'),
  },
  // Slack tokens. The bare `xox` trigram is too short to be unambiguous, so the
  // type letter and its dash are required.
  {
    kind: 'slack-token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
    render: () => redactionPlaceholder('slack-token'),
  },
])

// Returns the scrubbed text and a per-kind count of what was removed. Pure: the
// caller owns where it is applied, and it is applied at exactly one place.
export function redactDelta(value) {
  let text = String(value ?? '')
  const counts = {}
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2)
      if (rule.strong && !CREDENTIAL_VALUE_STRENGTH.test(String(groups[rule.strong] ?? ''))) return groups[0]
      counts[rule.kind] = (counts[rule.kind] || 0) + 1
      return rule.render(groups)
    })
  }
  return { text, counts }
}

