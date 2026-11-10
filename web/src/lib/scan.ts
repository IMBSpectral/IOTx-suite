import { listFiles, listFilesAt, readFile, readFileAt } from "./repo";

type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type Finding = {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  detail: string;
};

export type SecurityCheck = {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  /** Plain-language description, as on Lovable's security center. */
  looksFor: string;
  appliesWhen: string;
  passesWhen: string;
  /** A line that matches is a finding. */
  pattern?: RegExp;
  /** For whole-file conditions: return a 1-based line number when it fails. */
  fileCheck?: (source: string, file: string) => number | null;
  /** Only files whose path matches are inspected. */
  files?: RegExp;
};

const CODE = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
const MARKUP = /\.(?:tsx|jsx|html)$/i;

/**
 * Model-written code has predictable failure modes: a key pasted inline, an
 * innerHTML sink, an admin check made in the browser. Each check is phrased in
 * plain language so a non-engineer can tell what it means and whether it
 * matters for their app.
 */
export const CHECKS: SecurityCheck[] = [
  // --- Secrets and keys ----------------------------------------------------
  {
    id: "secret.anthropic-key", category: "Secrets and keys", severity: "CRITICAL",
    title: "Anthropic API key in the code",
    looksFor: "A Claude API key written directly into a file.",
    appliesWhen: "Always.", passesWhen: "No key-shaped strings are present.",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: "secret.openai-key", category: "Secrets and keys", severity: "CRITICAL",
    title: "OpenAI-style API key in the code",
    looksFor: "A vendor API key beginning with sk- written into a file.",
    appliesWhen: "Always.", passesWhen: "Keys are kept in secrets, not source.",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  {
    id: "secret.aws-key", category: "Secrets and keys", severity: "CRITICAL",
    title: "AWS access key in the code",
    looksFor: "An AWS access key id (AKIA…).", appliesWhen: "Always.", passesWhen: "None present.",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: "secret.private-key", category: "Secrets and keys", severity: "CRITICAL",
    title: "Private key committed",
    looksFor: "A PEM private key block.", appliesWhen: "Always.", passesWhen: "No private keys in the project.",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    id: "secret.github-token", category: "Secrets and keys", severity: "CRITICAL",
    title: "GitHub token in the code",
    looksFor: "A GitHub personal access or app token (ghp_, gho_, ghs_…).",
    appliesWhen: "Always.", passesWhen: "None present.",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: "secret.stripe-secret", category: "Secrets and keys", severity: "CRITICAL",
    title: "Stripe secret key in the code",
    looksFor: "A live Stripe secret key (sk_live_…), which can move money.",
    appliesWhen: "Always.", passesWhen: "Only publishable keys (pk_…) appear in browser code.",
    pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/,
  },
  {
    id: "secret.slack-token", category: "Secrets and keys", severity: "HIGH",
    title: "Slack token in the code",
    looksFor: "A Slack bot or user token (xoxb-, xoxp-…).", appliesWhen: "Always.", passesWhen: "None present.",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: "secret.google-key", category: "Secrets and keys", severity: "MEDIUM",
    title: "Google API key in the code",
    looksFor: "A Google API key (AIza…). Some are meant to be public, but only when restricted.",
    appliesWhen: "Always.", passesWhen: "The key is restricted to your domain in Google Cloud, or not present.",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "secret.service-role", category: "Secrets and keys", severity: "HIGH",
    title: "Database admin key referenced in app code",
    looksFor: "A Supabase service-role key, which bypasses every access rule.",
    appliesWhen: "The app talks to Supabase.", passesWhen: "Only the public anon key is used in the browser.",
    pattern: /service[_-]?role[_-]?key|SUPABASE_SERVICE_ROLE/i,
    files: CODE,
  },
  {
    id: "secret.generic-assignment", category: "Secrets and keys", severity: "HIGH",
    title: "Credential assigned a literal value",
    looksFor: "Variables named like api_key, secret, password or token set to a long literal.",
    appliesWhen: "Always.", passesWhen: "Credentials come from environment variables or secrets.",
    pattern: /\b(?:api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
  {
    id: "secret.env-committed", category: "Secrets and keys", severity: "CRITICAL",
    title: "Environment file committed",
    looksFor: "A .env file stored in the project, where its secrets ship with the code.",
    appliesWhen: "Always.", passesWhen: "No .env files are committed.",
    fileCheck: (_s, file) => (/(^|\/)\.env(\.[\w.-]+)?$/.test(file) && !/\.example$/.test(file) ? 1 : null),
    files: /(^|\/)\.env/,
  },

  // --- Injection and XSS ----------------------------------------------------
  {
    id: "xss.inner-html", category: "Injection and XSS", severity: "HIGH",
    title: "Raw HTML rendered with dangerouslySetInnerHTML",
    looksFor: "React's escape hatch for unescaped markup.",
    appliesWhen: "The HTML could include anything a user typed.", passesWhen: "Text is rendered as text, or sanitised first.",
    pattern: /dangerouslySetInnerHTML/, files: CODE,
  },
  {
    id: "xss.dom-innerhtml", category: "Injection and XSS", severity: "HIGH",
    title: "Page content set through innerHTML",
    looksFor: "Direct innerHTML/outerHTML assignment.", appliesWhen: "Always.", passesWhen: "textContent or React rendering is used.",
    pattern: /\.(?:inner|outer)HTML\s*=(?!=)/, files: CODE,
  },
  {
    id: "xss.document-write", category: "Injection and XSS", severity: "MEDIUM",
    title: "document.write used",
    looksFor: "Writing markup straight into the document.", appliesWhen: "Always.", passesWhen: "Not used.",
    pattern: /document\.write(?:ln)?\s*\(/, files: CODE,
  },
  {
    id: "xss.javascript-url", category: "Injection and XSS", severity: "HIGH",
    title: "javascript: link",
    looksFor: "Links whose address runs code.", appliesWhen: "Always.", passesWhen: "Buttons with click handlers are used instead.",
    pattern: /href\s*=\s*\{?\s*["'`]javascript:/i, files: MARKUP,
  },
  {
    id: "exec.eval", category: "Injection and XSS", severity: "HIGH",
    title: "Text executed as code",
    looksFor: "eval() or new Function().", appliesWhen: "Always.", passesWhen: "Neither is used.",
    pattern: /\beval\s*\(|new\s+Function\s*\(/, files: CODE,
  },
  {
    id: "exec.string-timeout", category: "Injection and XSS", severity: "MEDIUM",
    title: "Timer runs a string of code",
    looksFor: "setTimeout or setInterval given a string instead of a function.",
    appliesWhen: "Always.", passesWhen: "Timers receive functions.",
    pattern: /set(?:Timeout|Interval)\(\s*["'`]/, files: CODE,
  },
  {
    id: "sql.string-concat", category: "Injection and XSS", severity: "MEDIUM",
    title: "Database query built by joining strings",
    looksFor: "SQL assembled with + or template values, which allows SQL injection.",
    appliesWhen: "The app runs SQL.", passesWhen: "Parameterised queries or a query builder are used.",
    pattern: /["'`]\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^"'`]*["'`]\s*\+|`\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^`]*\$\{/i,
    files: CODE,
  },

  // --- Access control -----------------------------------------------------------
  {
    id: "auth.client-admin", category: "Access control", severity: "HIGH",
    title: "Admin access decided in the browser",
    looksFor: "An admin or role flag read from localStorage, a URL or a hard-coded value.",
    appliesWhen: "The app has admin-only areas.", passesWhen: "Roles are checked on the server or by database rules.",
    // Only a role or admin flag being SET in browser code: `isAdmin = true`, `role = "admin"`,
    // or one read from localStorage. Comparisons (`role === "admin"`, used to show or hide
    // things) and type lists (`type Role = "admin" | "hr"`) are not access decisions; flagging
    // them blocked publishing for apps whose roles live in the database (Nov 2026).
    pattern: /\bisAdmin\s*=(?!=)\s*true\b|(?<!type\s+)\brole\s*=(?!=)\s*["']admin["'](?!\s*\|)|localStorage\.getItem\(\s*["'](?:isAdmin|role|admin)/i,
    files: CODE,
  },
  {
    id: "auth.hardcoded-password", category: "Access control", severity: "HIGH",
    title: "Login compares against a password in the code",
    looksFor: "A password check against a literal value.", appliesWhen: "The app has a login.",
    passesWhen: "Passwords are checked by an auth service.",
    pattern: /password\s*===?\s*["'][^"']+["']|["'][^"']+["']\s*===?\s*password/i, files: CODE,
  },
  {
    id: "storage.token", category: "Access control", severity: "MEDIUM",
    title: "Credentials stored in localStorage",
    looksFor: "Tokens, secrets or passwords saved to localStorage, readable by any script on the page.",
    appliesWhen: "The app stores sign-in state.", passesWhen: "Sessions use secure cookies or the auth library's storage.",
    pattern: /localStorage\.setItem\(\s*["'][^"']*(?:token|secret|password)/i, files: CODE,
  },
  {
    id: "auth.unverified-jwt", category: "Access control", severity: "LOW",
    title: "Token contents trusted without verification",
    looksFor: "A sign-in token decoded in the browser and used for decisions.",
    appliesWhen: "The app uses JWTs.", passesWhen: "Decoded claims are only used for display.",
    pattern: /jwt[-_]?decode|atob\([^)]*split\(\s*["']\.["']\s*\)/i, files: CODE,
  },

  // --- Network and links -----------------------------------------------------------
  {
    id: "net.insecure-url", category: "Network and links", severity: "LOW",
    title: "Insecure http:// address",
    looksFor: "Requests or links to unencrypted http:// addresses.", appliesWhen: "Always.", passesWhen: "Everything uses https://.",
    pattern: /["'`]http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org|[^"'`]*\.localhost)/,
  },
  {
    id: "net.target-blank", category: "Network and links", severity: "LOW",
    title: "New-tab links without rel=noopener",
    looksFor: "target=\"_blank\" links that let the opened page control yours.",
    appliesWhen: "Links open in a new tab.", passesWhen: "Every such link has rel=\"noopener\" or \"noreferrer\".",
    pattern: /target=["']_blank["'](?![^>]*\brel=)/, files: MARKUP,
  },
  {
    id: "net.postmessage-star", category: "Network and links", severity: "MEDIUM",
    title: "Messages sent to any website",
    looksFor: "postMessage with a \"*\" target, so any page embedding yours can read it.",
    appliesWhen: "The app talks to frames or popups.", passesWhen: "A specific origin is named.",
    pattern: /postMessage\([^)]*,\s*["']\*["']\s*\)/, files: CODE,
  },
  {
    id: "net.message-origin", category: "Network and links", severity: "MEDIUM",
    title: "Incoming messages accepted from any website",
    looksFor: "A message listener that never checks event.origin.",
    appliesWhen: "The app listens for window messages.", passesWhen: "The sender's origin is checked.",
    fileCheck: (s) => {
      const at = s.search(/addEventListener\(\s*["']message["']/);
      if (at < 0 || /\.origin\b/.test(s)) return null;
      return s.slice(0, at).split("\n").length;
    },
    files: CODE,
  },
  {
    id: "net.open-redirect", category: "Network and links", severity: "MEDIUM",
    title: "Redirect target taken from the URL",
    looksFor: "Navigation to an address read from the query string, which attackers use for phishing.",
    appliesWhen: "The app redirects after login or similar.", passesWhen: "Only known paths are allowed.",
    pattern: /(?:window\.)?location(?:\.href)?\s*=\s*[^;]*(?:searchParams|URLSearchParams|params\.get|query\.)/,
    files: CODE,
  },
  {
    id: "net.cors-wildcard", category: "Network and links", severity: "MEDIUM",
    title: "API open to every website",
    looksFor: "Access-Control-Allow-Origin: * on an API.", appliesWhen: "The project includes server code.",
    passesWhen: "Only your own origins are allowed.",
    pattern: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/i,
  },
  {
    id: "frame.no-sandbox", category: "Network and links", severity: "LOW",
    title: "Embedded page without sandbox",
    looksFor: "<iframe> elements with no sandbox attribute.", appliesWhen: "The app embeds other pages.",
    passesWhen: "Embedded content is sandboxed or fully trusted.",
    pattern: /<iframe(?![^>]*\bsandbox\b)/i, files: MARKUP,
  },

  // --- Cryptography ------------------------------------------------------------------
  {
    id: "crypto.weak-hash", category: "Cryptography", severity: "MEDIUM",
    title: "Weak hashing (MD5 or SHA-1)",
    looksFor: "MD5 or SHA-1, which are broken for security purposes.",
    appliesWhen: "Hashes protect passwords or integrity.", passesWhen: "SHA-256 or a password hash (bcrypt, argon2) is used.",
    pattern: /createHash\(\s*["'](?:md5|sha1)["']\)|\b(?:md5|sha1)\s*\(/i, files: CODE,
  },
  {
    id: "crypto.weak-random", category: "Cryptography", severity: "MEDIUM",
    title: "Predictable random values for secrets",
    looksFor: "Math.random() used to make tokens, codes or ids that must not be guessed.",
    appliesWhen: "The app generates codes or tokens.", passesWhen: "crypto.getRandomValues or randomUUID is used.",
    pattern: /Math\.random\(\)[^;\n]*(?:token|secret|code|password|otp)|(?:token|secret|password|otp)[^;\n=]*=[^;\n]*Math\.random\(\)/i,
    files: CODE,
  },

  // --- Privacy -------------------------------------------------------------------------
  {
    id: "privacy.logged-secret", category: "Privacy", severity: "LOW",
    title: "Sensitive values written to the console",
    looksFor: "console.log calls that print passwords, tokens or secrets.",
    appliesWhen: "Always.", passesWhen: "Sensitive values are never logged.",
    pattern: /console\.(?:log|info|debug)\([^)]*(?:password|token|secret)/i, files: CODE,
  },
];

const SKIP = /^(?:\.git\/|node_modules\/|\.builds\/|dist\/)/;
const TEXT = /\.(?:tsx?|jsx?|mjs|cjs|css|html|json|md|txt|env(?:\.[\w.-]+)?)$|(^|\/)\.env/i;

export async function scanProject(
  projectId: string,
  opts: { disabled?: string[]; ref?: string } = {},
): Promise<Finding[]> {
  // With a ref, the scan reads that version (main, for publishing), not the working tree.
  const files = opts.ref ? await listFilesAt(projectId, opts.ref) : await listFiles(projectId);
  const findings: Finding[] = [];
  const active = CHECKS.filter((c) => !opts.disabled?.includes(c.id));

  for (const file of files) {
    if (SKIP.test(file) || !TEXT.test(file)) continue;

    let source: string;
    try {
      source = opts.ref ? await readFileAt(projectId, opts.ref, file) : await readFile(projectId, file);
    } catch {
      continue;
    }
    // A minified or generated blob produces noise, not signal.
    if (source.length > 400_000) continue;

    const lines = source.split("\n");
    for (const check of active) {
      if (check.files && !check.files.test(file)) continue;
      let line: number | null = null;
      if (check.fileCheck) line = check.fileCheck(source, file);
      else if (check.pattern) {
        const i = lines.findIndex((l) => check.pattern!.test(l));
        line = i >= 0 ? i + 1 : null;
      }
      // One finding per check per file is enough to act on.
      if (line !== null) {
        findings.push({ rule: check.id, severity: check.severity, file, line, detail: check.title });
      }
    }
  }

  return findings;
}
