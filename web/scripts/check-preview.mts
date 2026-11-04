import "dotenv/config";
import { bundleProject } from "../src/lib/preview";
async function main() {
  const r = await bundleProject("8a99864b-0350-4a08-a800-3ab719dbcabf");
  console.log("ok:", r.ok, "error:", r.error ?? "none", "len:", r.html.length);
  const i = r.html.indexOf("(function () {");
  console.log("inspector injected at:", i);
  // print a small window around the inspector's regex, the likeliest mangling
  const j = r.html.indexOf("split(");
  console.log("split fragment:", JSON.stringify(r.html.slice(j, j + 40)));
}
main().catch(e => { console.error("THREW:", e.message); process.exit(1); });
