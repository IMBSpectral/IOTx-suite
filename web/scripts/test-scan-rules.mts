import { CHECKS } from "../src/lib/scan";
// Each check must fire on its bad sample and stay quiet on its good one.
const cases: Record<string, [string, string, string]> = {
  "secret.anthropic-key": ["a.ts", 'const k = "sk-ant-' + 'abcdefghijklmnopqrstuvwxyz0123";', "const k = process.env.KEY;"],
  "secret.github-token": ["a.ts", 'const t = "ghp_' + "a".repeat(36) + '";', "const t = '';"],
  "xss.dom-innerhtml": ["a.ts", "el.innerHTML = value;", "el.textContent = value;"],
  "xss.javascript-url": ["a.tsx", '<a href="javascript:void(0)">x</a>', '<a href="/about">x</a>'],
  "net.target-blank": ["a.tsx", '<a href="x" target="_blank">x</a>', '<a href="x" target="_blank" rel="noopener">x</a>'],
  "net.postmessage-star": ["a.ts", 'parent.postMessage(data, "*")', 'parent.postMessage(data, "https://app.com")'],
  "auth.client-admin": ["a.ts", 'if (localStorage.getItem("isAdmin")) show();', "if (user.claims.admin) show();"],
  "auth.hardcoded-password": ["a.ts", 'if (password === "hunter22") ok();', "await signIn(email, password);"],
  "crypto.weak-random": ["a.ts", "const token = Math.random().toString(36);", "const token = crypto.randomUUID();"],
  "sql.string-concat": ["a.ts", 'db.query("SELECT * FROM users WHERE id = " + id)', 'db.query("SELECT * FROM users WHERE id = $1", [id])'],
  "frame.no-sandbox": ["a.tsx", '<iframe src="x" />', '<iframe src="x" sandbox="allow-scripts" />'],
  "privacy.logged-secret": ["a.ts", "console.log('token', token)", "console.log('loaded')"],
};
let failed = 0;
for (const [id, [file, bad, good]] of Object.entries(cases)) {
  const c = CHECKS.find((x) => x.id === id)!;
  const hit = (src: string) =>
    (!c.files || c.files.test(file)) && (c.fileCheck ? c.fileCheck(src, file) !== null : c.pattern!.test(src));
  const ok = hit(bad) && !hit(good);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  bad=${hit(bad)} good=${hit(good)}`);
}
const msg = CHECKS.find((x) => x.id === "net.message-origin")!;
const okMsg = msg.fileCheck!("window.addEventListener('message', e => run(e.data))", "a.ts") !== null &&
  msg.fileCheck!("window.addEventListener('message', e => { if (e.origin !== O) return; })", "a.ts") === null;
console.log(`${okMsg ? "PASS" : "FAIL"}  net.message-origin`);
console.log(`\n${CHECKS.length} checks in ${new Set(CHECKS.map((c) => c.category)).size} categories; ${failed + (okMsg ? 0 : 1)} failing samples`);
