/**
 * Cloud storage: buckets, uploads by app users, public URLs, owner-only files,
 * signed links (and their expiry/tampering), listing, deleting, path safety,
 * HTML never served inline, and the Cloud manager's storage actions.
 *   npx tsx scripts/test-cycle22.mts <devToken> <usersJson>
 */
import "dotenv/config";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000";
const [token, usersPath] = process.argv.slice(2);
const users = JSON.parse(await fs.readFile(usersPath, "utf8")) as Record<string, string>;
const cookie = `authjs.session-token=${token}`;
const UA = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (path: string, body?: unknown, c = cookie) => {
  const r = await fetch(`${BASE}${path}`, body === undefined ? { headers: { cookie: c } } : { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};
let pid = "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

try {
  pid = ((await call("/api/projects", { name: "C22 storage", force: true })).json.project as { id: string }).id;
  await call(`/api/projects/${pid}/cloud`, { action: "enable" });
  const { anonKey } = (await call(`/api/projects/${pid}/cloud`)).json as { anonKey: string };
  const C = `${BASE}/cloud/v1/${pid}`;
  const A = `/api/projects/${pid}/cloud/admin`;
  const app = (path: string, init: RequestInit & { as?: string } = {}) =>
    fetch(C + path, { ...init, headers: { apikey: anonKey, "user-agent": UA, ...(init.as ? { authorization: `Bearer ${init.as}` } : {}), ...(init.headers ?? {}) } });
  const signup = async (email: string) =>
    ((await (await app("/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password123" }) })).json()) as { token: string; user: { id: string } });
  const ana = await signup("ana@example.com");
  const bo = await signup("bo@example.com");

  // Writes need a signed-in user
  check("anonymous uploads are refused", (await app("/storage/object/public/logo.png", { method: "PUT", headers: { "content-type": "image/png" }, body: PNG })).status === 401);
  const up = await app("/storage/object/public/products/logo.png", { method: "PUT", headers: { "content-type": "image/png" }, body: PNG, as: ana.token });
  const upJson = (await up.json()) as { url: string; size: number };
  check("a signed-in user can upload to a public bucket", up.status === 201 && upJson.size === PNG.length && !!upJson.url, JSON.stringify(upJson));

  // Public URL works without any key (plain <img src>)
  const pub = await fetch(upJson.url);
  const pubBytes = Buffer.from(await pub.arrayBuffer());
  check("public files open without the anon key, as an image", pub.status === 200 && pub.headers.get("content-type") === "image/png" && pubBytes.equals(PNG));

  // Owner-only bucket
  await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "Ana's private notes", as: ana.token });
  const own = await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { as: ana.token });
  check("the uploader can read their private file", own.status === 200 && (await own.text()) === "Ana's private notes");
  check("other users can't read it", (await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { as: bo.token })).status === 404);
  check("private files have no public URL", (await fetch(`${C}/storage/public/uploads/${ana.user.id}/notes.txt`)).status === 404);
  const boList = (await (await app("/storage/list/uploads", { as: bo.token })).json()) as unknown[];
  const anaList = (await (await app("/storage/list/uploads", { as: ana.token })).json()) as { path: string }[];
  check("listing an owner bucket shows only your own files", boList.length === 0 && anaList.length === 1 && anaList[0].path === `${ana.user.id}/notes.txt`);
  check("others can't overwrite your file", (await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { method: "PUT", body: "hacked", as: bo.token })).status === 403);
  check("or delete it", (await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { method: "DELETE", as: bo.token })).status === 403);

  // Signed URLs
  const signed = (await (await app(`/storage/sign/uploads/${ana.user.id}/notes.txt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 120 }), as: ana.token })).json()) as { url: string };
  const viaLink = await fetch(signed.url);
  check("a signed link opens the private file for anyone", viaLink.status === 200 && (await viaLink.text()) === "Ana's private notes");
  check("a tampered signed link is refused", (await fetch(signed.url.replace("notes.txt", "other.txt"))).status === 403);
  const expired = signed.url.replace(/exp=\d+/, "exp=1000");
  check("an expired link is refused", (await fetch(expired)).status === 403);
  check("people who can't read a file can't sign it", (await app(`/storage/sign/uploads/${ana.user.id}/notes.txt`, { method: "POST", body: "{}", as: bo.token })).status === 404);

  // Safety
  check("paths with .. are refused", (await app("/storage/object/public/..%2F..%2Fconfig.json", { method: "PUT", body: "x", as: ana.token })).status === 400);
  check("unknown buckets are refused", (await app("/storage/object/nope/a.txt", { method: "PUT", body: "x", as: ana.token })).status === 404);
  await app("/storage/object/public/page.html", { method: "PUT", headers: { "content-type": "text/html" }, body: "<script>alert(1)</script>", as: ana.token });
  const html = await fetch(`${C}/storage/public/public/page.html`);
  check("uploaded HTML is downloaded, never rendered", html.headers.get("content-type") === "application/octet-stream" && /attachment/.test(html.headers.get("content-disposition") ?? ""));

  // Owner can delete
  check("the uploader can delete their file", (await app(`/storage/object/uploads/${ana.user.id}/notes.txt`, { method: "DELETE", as: ana.token })).status === 200);

  // Cloud manager
  const made = await call(A, { action: "createBucket", name: "avatars", access: "authenticated" });
  check("the Cloud manager can make a bucket", made.status === 201);
  await app("/storage/object/avatars/bo.png", { method: "PUT", headers: { "content-type": "image/png" }, body: PNG, as: bo.token });
  check("a shared bucket lets any signed-in user read", (await app("/storage/object/avatars/bo.png", { as: ana.token })).status === 200);
  const info = (await call(`${A}?view=storage`)).json as { buckets: { name: string; files: number }[]; used: { files: number } };
  check("buckets are listed with file counts", info.buckets.find((b) => b.name === "public")?.files === 2 && info.buckets.find((b) => b.name === "avatars")?.files === 1 && info.used.files === 3, JSON.stringify(info));
  const upAdmin = await call(A, { action: "uploadFile", bucket: "public", path: "docs/readme.txt", contentType: "text/plain", base64: Buffer.from("hello").toString("base64") });
  check("the Cloud manager can upload", upAdmin.status === 201);
  const files = (await call(`${A}?view=files&bucket=public&prefix=docs/`)).json as { files: { path: string }[] };
  check("and browse a folder", files.files.length === 1 && files.files[0].path === "docs/readme.txt");
  const dl = await fetch(`${BASE}${A}?view=file&bucket=public&path=docs/readme.txt`, { headers: { cookie } });
  check("and download a file", dl.status === 200 && (await dl.text()) === "hello");
  await call(A, { action: "deleteBucket", name: "avatars" });
  check("deleting a bucket removes its files", (await app("/storage/object/avatars/bo.png", { as: bo.token })).status === 404);

  const outsider = `authjs.session-token=${users["outsider@localhost"]}`;
  const o = (await call(`${A}?view=storage`, undefined, outsider)).status;
  check("people without edit access are refused", o === 403 || o === 404);
} catch (e) {
  check("no unexpected error", false, String(e));
} finally {
  if (pid) await fetch(`${BASE}/api/projects/${pid}?permanent=1`, { method: "DELETE", headers: { cookie } });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
