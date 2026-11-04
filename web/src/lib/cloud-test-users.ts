import crypto from "node:crypto";
import { getBrand } from "./brand";
import { CloudError, getCloud, openDatabase, sessionFor, signUp, updateCloud } from "./cloud";
import { open as openBox, seal, type SecretBox } from "./secret-box";

/**
 * Test users the agent makes in the app's own Cloud so it can check pages
 * behind sign-in. Each is kept (password sealed) and reused next time, and is
 * listed in the Cloud tab like any other user.
 */

const PURPOSE = "forge-cloud-test-users";
type Stored = { label: string; email: string; password: SecretBox; createdAt: string };

const LABEL = /^[a-z0-9-]{1,20}$/;

export async function testUsers(projectId: string) {
  const cfg = await getCloud(projectId);
  return ((cfg as { testUsers?: Stored[] } | null)?.testUsers ?? []).map((u) => ({ label: u.label, email: u.email, createdAt: u.createdAt }));
}

/** The test user with this label, made on first use. */
export async function ensureTestUser(projectId: string, rawLabel = "tester") {
  const label = rawLabel.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 20) || "tester";
  if (!LABEL.test(label)) throw new CloudError("Use letters, numbers and dashes for the test user's label.");
  const cfg = await getCloud(projectId);
  if (!cfg?.enabled) throw new CloudError(`${getBrand().shortName} Cloud isn't on for this app, so there are no accounts to test with.`, 404);
  const stored = ((cfg as { testUsers?: Stored[] }).testUsers ?? []).find((u) => u.label === label);
  const db = openDatabase(projectId);
  if (stored && (await db.get("SELECT 1 FROM auth_users WHERE email = ?", [stored.email]))) {
    return { label, email: stored.email, password: openBox(PURPOSE, stored.password), created: false };
  }
  const email = `forge-test-${label}-${crypto.randomBytes(3).toString("hex")}@example.com`;
  const password = crypto.randomBytes(12).toString("base64url");
  await signUp(projectId, cfg, email, password);
  await updateCloud(projectId, (c) => {
    const list = ((c as { testUsers?: Stored[] }).testUsers ??= []).filter((u) => u.label !== label);
    list.push({ label, email, password: seal(PURPOSE, password), createdAt: new Date().toISOString() });
    (c as { testUsers?: Stored[] }).testUsers = list.slice(-10);
  });
  return { label, email, password, created: true };
}

/** A signed-in session for a test user, to open the app as them. */
export async function testUserSession(projectId: string, label?: string) {
  const u = await ensureTestUser(projectId, label);
  const cfg = await getCloud(projectId);
  return { user: u, session: await sessionFor(projectId, cfg!, u.email) };
}
