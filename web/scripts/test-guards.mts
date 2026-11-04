import { inspectOutgoing } from "../src/components/chat/ChatComposer";
const cases: [string, string | null][] = [
  ["make the header blue", null],
  ["-----BEGIN RSA PRIVATE KEY-----\nabc", "block"],
  ["use my key sk-ant-" + "abcdefghijklmnopqrstuvwxyz012345", "warn"],
  ["card 4111 1111 1111 1111 for testing", "warn"],
  ["order number 1234 5678 9012 3456", null],
  ["my aadhaar is 2345 6789 0123", "warn"],
  ["PAN ABCDE1234F", "warn"],
  ["call me at 555-123-4567", null],
  ["ssn 123-45-6789", "warn"],
];
let bad = 0;
for (const [text, want] of cases) {
  const got = inspectOutgoing(text)?.kind ?? null;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${JSON.stringify(text.slice(0, 40))} -> ${got}`);
}
console.log(bad ? `${bad} failing` : "all pass");
