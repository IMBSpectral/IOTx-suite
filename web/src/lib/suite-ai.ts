import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "./db";
import * as g from "./google";
import { audit } from "./workspace-security";
import { PermissionError } from "./iotx/permissions";
import { mailboxesFor } from "./mail/mailbox";
import { openMessage, syncFolder } from "./mail/sync";
import { bodyOf } from "./mail/ai";

/** Workspace (Tasks, Calendar, Chat, Meet) on this server, for server-to-server calls. */
const WORKSPACE_INTERNAL = (process.env.WORKSPACE_INTERNAL_URL ?? "http://127.0.0.1:3100/workspace").replace(/\/$/, "");

/**
 * The suite-wide side of the assistant: the tabs the person has open (read
 * one, fill another), their Google Sheets, Docs and Slides, what it remembers
 * about them, and the web. Used by AI Chat and the floating assistant.
 */

/** One open suite tab, as the frame read it when the message was sent. */
export type OpenTab = { id: string; title: string; url: string; active?: boolean; text?: string; fields?: string[] };

/** Something the assistant asks the person's browser to do once it's said it. */
export type SuiteAction =
  | { kind: "fill"; tabId: string; text: string; field?: string; replace?: boolean }
  | { kind: "open"; url: string }
  | { kind: "reload"; match: string }
  /** The suite's own sidebar and menus (after a dashboard, folder or app changes). */
  | { kind: "shell" };

export type Live = {
  step: (label: string) => void;
  action: (a: SuiteAction) => void;
};

const MEMORY_LIMIT = 60;

/** The facts the assistant keeps about this person, oldest first, for the system prompt. */
export async function memoryContext(userId: string, workspaceId: string) {
  const [facts, recent] = await Promise.all([
    db.assistantMemory.findMany({ where: { userId, workspaceId }, orderBy: { createdAt: "desc" }, take: MEMORY_LIMIT }),
    db.auditEvent.findMany({ where: { workspaceId, actorId: userId, kind: "ai.action" }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  let out = "";
  if (facts.length)
    out += `\n\nWhat you remember about this person (from earlier conversations; use it, don't recite it):\n${facts
      .reverse()
      .map((f) => `- [${f.id}] ${f.fact}`)
      .join("\n")}`;
  if (recent.length)
    out += `\n\nWhat you did for them recently, newest first (the audit log):\n${recent.map((r) => `- ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")}: ${r.detail}`).join("\n")}`;
  return out;
}

const plain = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut at ${n} characters)` : s);

/** A Google Doc's text with each paragraph's start index, so edits can target it. */
export function docText(doc: Record<string, unknown>) {
  type El = { startIndex?: number; endIndex?: number; paragraph?: { elements?: { textRun?: { content?: string } }[] }; table?: { tableRows?: { tableCells?: { content?: El[] }[] }[] } };
  const lines: string[] = [];
  const walk = (els: El[] | undefined) => {
    for (const e of els ?? []) {
      if (e.paragraph) {
        const t = (e.paragraph.elements ?? []).map((x) => x.textRun?.content ?? "").join("").replace(/\n$/, "");
        lines.push(`[${e.startIndex ?? 0}] ${t}`);
      } else if (e.table) for (const r of e.table.tableRows ?? []) for (const c of r.tableCells ?? []) walk(c.content);
    }
  };
  const body = (doc.body as { content?: El[] } | undefined)?.content;
  walk(body);
  const end = body?.length ? (body[body.length - 1].endIndex ?? 1) : 1;
  return { text: lines.join("\n"), end };
}

/** A presentation's slides: ids, and each shape's id and text. */
export function slidesText(p: Record<string, unknown>) {
  type Shape = { objectId: string; shape?: { text?: { textElements?: { textRun?: { content?: string } }[] } } };
  const slides = (p.slides as { objectId: string; pageElements?: Shape[] }[] | undefined) ?? [];
  return slides
    .map((s, i) => {
      const shapes = (s.pageElements ?? [])
        .map((e) => {
          const t = (e.shape?.text?.textElements ?? []).map((x) => x.textRun?.content ?? "").join("").trim();
          return t ? `  shape ${e.objectId}: ${t.replace(/\n/g, " / ")}` : `  element ${e.objectId}`;
        })
        .join("\n");
      return `Slide ${i + 1} (id ${s.objectId})\n${shapes}`;
    })
    .join("\n");
}

export function suiteTools(opts: { userId: string; workspaceId: string; perms: Set<string>; tabs: OpenTab[] | null; live: Live }) {
  const { userId, workspaceId, perms, tabs, live } = opts;
  const did = (detail: string) => void audit(workspaceId, userId, "ai.action", detail);
  const out: (ReturnType<typeof betaZodTool> | Anthropic.Beta.BetaToolUnion)[] = [];

  // ── Memory ──
  out.push(
    betaZodTool({
      name: "remember",
      description:
        "Save a lasting fact or preference about this person or their work for future conversations (their role, the reports they want, how they like answers, recurring names and numbers). " +
        "Use it when they tell you something worth keeping or ask you to remember. Not for one-off details.",
      inputSchema: z.object({ fact: z.string().min(3).max(500) }),
      run: async ({ fact }) => {
        const n = await db.assistantMemory.count({ where: { userId, workspaceId } });
        if (n >= 200) return "Memory is full (200 facts). Ask the person to remove some under Memory in the AI panel.";
        await db.assistantMemory.create({ data: { userId, workspaceId, fact: fact.trim() } });
        void audit(workspaceId, userId, "ai.memory", `Remembered: ${fact.slice(0, 200)}`);
        live.step(`Remembered: ${fact.slice(0, 60)}`);
        return "Saved to memory.";
      },
    }),
    betaZodTool({
      name: "forget",
      description: "Remove a remembered fact by its id (shown in brackets in your memory) when it's wrong, outdated or the person asks.",
      inputSchema: z.object({ id: z.string() }),
      run: async ({ id }) => {
        const r = await db.assistantMemory.deleteMany({ where: { id, userId, workspaceId } });
        if (r.count) live.step("Forgot a remembered fact");
        return r.count ? "Removed." : "No such memory.";
      },
    }),
  );

  // ── Dashboards and folders in the sidebar (only those the person may see) ──
  out.push(
    betaZodTool({
      name: "suite_spaces",
      description: "The dashboards and folders in the person's sidebar. With a name, what's in that one: its apps (projects, with ids and published addresses), links and sub-folders.",
      inputSchema: z.object({ name: z.string().max(100).optional() }),
      run: async ({ name }) => {
        const spaces = await import("./spaces");
        const v = await spaces.viewer(userId, workspaceId);
        const { spaces: list } = await spaces.sidebar(v);
        if (!name) return JSON.stringify(list.map((s) => ({ id: s.id, kind: s.kind, name: s.name, inside: s.parentId ? list.find((p) => p.id === s.parentId)?.name : undefined })));
        const hit = list.find((s) => s.id === name || s.name.toLowerCase() === name.toLowerCase());
        if (!hit) return `No dashboard or folder "${name}" in their sidebar.`;
        const s = await spaces.open(v, hit.id);
        live.step(`Looked at the ${s.kind} ${s.name}`);
        return JSON.stringify({ kind: s.kind, name: s.name, address: `/spaces/${s.id}`, folders: s.children.map((c) => c.name), items: s.items });
      },
    }),
  );

  // ── The web (Anthropic's server tools: searched and fetched by the API) ──
  if (perms.has("home.web")) out.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 });

  // ── Open tabs ──
  if (tabs) {
    const tab = (id: string) => tabs.find((t) => t.id === id) ?? null;
    out.push(
      betaZodTool({
        name: "list_open_tabs",
        description: "The suite tabs the person has open right now (id, title, address, which is active, and the fields they can be filled into).",
        inputSchema: z.object({}),
        run: async () =>
          JSON.stringify(tabs.map((t, i) => ({ id: t.id, n: i + 1, title: t.title, url: t.url, active: !!t.active, readable: !!t.text, fields: t.fields ?? [] }))),
      }),
      betaZodTool({
        name: "read_tab",
        description: "Read what an open suite tab shows: its visible text (the Builder's chat and replies, a Mail message, a Sheet, a dashboard, a meeting's notes…).",
        inputSchema: z.object({ tabId: z.string() }),
        run: async ({ tabId }) => {
          const t = tab(tabId);
          if (!t) return "No open tab with that id. Call list_open_tabs.";
          live.step(`Read tab: ${t.title.slice(0, 50)}`);
          return t.text ? plain(t.text, 40_000) : `"${t.title}" isn't loaded (it was in the background too long) or can't be read. Ask the person to click that tab once, then try again.`;
        },
      }),
      betaZodTool({
        name: "fill_tab",
        description:
          "Put text into a field in an open tab: a Builder prompt, an email body, a form field, a document being typed. " +
          "It goes into the field the person last used on that tab, or the field you name (from list_open_tabs). It isn't sent or submitted: they review it there.",
        inputSchema: z.object({ tabId: z.string(), text: z.string().min(1).max(50_000), field: z.string().max(200).optional(), replace: z.boolean().optional().describe("Replace what's in the field instead of adding to it") }),
        run: async ({ tabId, text, field, replace }) => {
          const t = tab(tabId);
          if (!t) return "No open tab with that id. Call list_open_tabs.";
          live.action({ kind: "fill", tabId, text, field, replace });
          live.step(`Filled tab: ${t.title.slice(0, 50)}`);
          did(`Filled text into the "${t.title.slice(0, 80)}" tab`);
          return `Done: the text goes into "${t.title}" as soon as you finish replying. Tell the person to check it there.`;
        },
      }),
      betaZodTool({
        name: "open_in_suite",
        description: "Open a suite page in a new tab (an address starting with /, like /sheets, /projects/<id>, /spaces/<id>).",
        inputSchema: z.object({ url: z.string().regex(/^\/[^/]/) }),
        run: async ({ url }) => {
          live.action({ kind: "open", url });
          live.step(`Opened ${url}`);
          return "Opened.";
        },
      }),
    );
  }

  // ── Google Sheets, Docs and Slides (the person's own Drive, with their role's permissions) ──
  const kinds = (["sheets", "docs", "slides"] as const).filter((k) => perms.has(`${k}.google`));
  if (kinds.length) {
    const can = (k: g.Kind, edit = false) => perms.has(edit ? `${k}.google.edit` : `${k}.google`);
    const guard = async <T,>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof g.GoogleError) return `Google said: ${e.message}` as unknown as T;
        throw e;
      }
    };
    const kindEnum = z.enum(kinds as unknown as [g.Kind, ...g.Kind[]]);
    out.push(
      betaZodTool({
        name: "find_office_files",
        description: "Find the person's Google Sheets, Docs or Slides by name (newest first). Returns ids for the read and edit tools.",
        inputSchema: z.object({ kind: kindEnum, search: z.string().max(100).optional() }),
        run: async ({ kind, search }) =>
          guard(async () => {
            const d = await g.listFiles(userId, kind, search || undefined);
            return JSON.stringify(d.files.slice(0, 25).map((f) => ({ id: f.id, name: f.name, modified: f.modifiedTime.slice(0, 10) })));
          }),
      }),
      betaZodTool({
        name: "create_office_file",
        description: "Create a new, empty Google Sheet, Doc or Slides deck, then fill it with the edit tools.",
        inputSchema: z.object({ kind: kindEnum, name: z.string().min(1).max(200) }),
        run: async ({ kind, name }) =>
          guard(async () => {
            if (!can(kind, true)) return `This person's role can't create ${kind}.`;
            const f = await g.createFile(userId, kind, name);
            live.step(`Created ${name}`);
            did(`Created the ${kind.slice(0, -1)} "${name}"`);
            live.action({ kind: "open", url: `/${kind}/${f.id}` });
            return JSON.stringify({ id: f.id, name: f.name, opened: `/${kind}/${f.id}` });
          }),
      }),
    );
    if (kinds.includes("sheets"))
      out.push(
        betaZodTool({
          name: "read_sheet",
          description: "Read a Google Sheet: its tabs, and the cell values of a range in A1 notation (default: the whole first tab).",
          inputSchema: z.object({ id: z.string(), range: z.string().max(200).optional() }),
          run: async ({ id, range }) =>
            guard(async () => {
              const [meta, v] = await Promise.all([g.sheetTabs(userId, id), g.sheetValues(userId, id, range)]);
              live.step(`Read sheet: ${meta.title.slice(0, 50)}`);
              return plain(JSON.stringify({ title: meta.title, tabs: meta.tabs, range: v.range, values: v.values }), 60_000);
            }),
        }),
        betaZodTool({
          name: "write_sheet",
          description:
            "Write values into a Google Sheet, as if typed (formulas like =SUM(B2:B9), numbers and dates work). Each entry is a range in A1 notation (\"Sheet1!A1\") and the rows of values starting there.",
          inputSchema: z.object({ id: z.string(), data: z.array(z.object({ range: z.string().max(200), values: z.array(z.array(z.string())) })).min(1).max(20) }),
          run: async ({ id, data }) =>
            guard(async () => {
              if (!can("sheets", true)) return "This person's role can't edit Google Sheets.";
              const ops = g.checkSheetOps([{ t: "values", data }]);
              await g.sheetWrite(userId, id, ops);
              const cells = data.reduce((n, d) => n + d.values.reduce((m, r) => m + r.length, 0), 0);
              live.step(`Wrote ${cells} cell${cells === 1 ? "" : "s"} in a sheet`);
              live.action({ kind: "reload", match: `/sheets/${id}` });
              did(`Wrote ${cells} cells in a Google Sheet (${data.map((d) => d.range).join(", ").slice(0, 120)})`);
              return "Written.";
            }),
        }),
      );
    if (kinds.includes("docs"))
      out.push(
        betaZodTool({
          name: "read_doc",
          description: "Read a Google Doc: its title, revision, and each paragraph prefixed with its start index (for edit_doc). The last index is the document's end.",
          inputSchema: z.object({ id: z.string() }),
          run: async ({ id }) =>
            guard(async () => {
              const d = await g.docGet(userId, id);
              const { text, end } = docText(d);
              live.step(`Read doc: ${d.title.slice(0, 50)}`);
              return plain(`Title: ${d.title}\nRevision: ${d.revisionId ?? ""}\nEnd index: ${end}\n\n${text}`, 60_000);
            }),
        }),
        betaZodTool({
          name: "edit_doc",
          description:
            "Change a Google Doc with Docs API batchUpdate requests: insertText {location:{index}, text}, deleteContentRange {range:{startIndex,endIndex}}, replaceAllText {containsText:{text,matchCase}, replaceText}, " +
            "updateTextStyle, updateParagraphStyle (e.g. namedStyleType HEADING_1), createParagraphBullets, insertTable, insertPageBreak. Read the doc first for indexes; to add at the end insert at end index - 1. " +
            "Requests run in order, so when inserting several pieces go from the end backwards.",
          inputSchema: z.object({ id: z.string(), requests: z.array(z.record(z.string(), z.unknown())).min(1).max(200) }),
          run: async ({ id, requests }) =>
            guard(async () => {
              if (!can("docs", true)) return "This person's role can't edit Google Docs.";
              const r = await g.officeWrite(userId, "docs", id, g.checkOfficeRequests(requests, g.DOC_REQUESTS));
              if (r.conflict) return "The doc changed meanwhile; read it again and retry.";
              live.step(`Edited a doc (${requests.length} change${requests.length === 1 ? "" : "s"})`);
              live.action({ kind: "reload", match: `/docs/${id}` });
              did(`Edited a Google Doc (${requests.length} changes)`);
              return "Done.";
            }),
        }),
      );
    if (kinds.includes("slides"))
      out.push(
        betaZodTool({
          name: "read_slides",
          description: "Read a Google Slides deck: each slide's id and its shapes' ids and text (for edit_slides).",
          inputSchema: z.object({ id: z.string() }),
          run: async ({ id }) =>
            guard(async () => {
              const p = await g.slidesGet(userId, id);
              live.step(`Read deck: ${(p.title ?? "Slides").slice(0, 50)}`);
              return plain(`Title: ${p.title ?? ""}\n\n${slidesText(p)}`, 60_000);
            }),
        }),
        betaZodTool({
          name: "edit_slides",
          description:
            "Change a Google Slides deck with Slides API batchUpdate requests: createSlide {slideLayoutReference:{predefinedLayout:\"TITLE_AND_BODY\"}, placeholderIdMappings}, insertText {objectId, text}, deleteText, replaceAllText, " +
            "createShape, createTable, deleteObject, updateTextStyle, updateSlidesPosition. Read the deck first for object ids. To fill a new slide's title and body, give createSlide placeholderIdMappings with your own ids, then insertText into them.",
          inputSchema: z.object({ id: z.string(), requests: z.array(z.record(z.string(), z.unknown())).min(1).max(200) }),
          run: async ({ id, requests }) =>
            guard(async () => {
              if (!can("slides", true)) return "This person's role can't edit Google Slides.";
              const r = await g.officeWrite(userId, "slides", id, g.checkOfficeRequests(requests, g.SLIDE_REQUESTS));
              if (r.conflict) return "The deck changed meanwhile; read it again and retry.";
              live.step(`Edited a deck (${requests.length} change${requests.length === 1 ? "" : "s"})`);
              live.action({ kind: "reload", match: `/slides/${id}` });
              did(`Edited a Google Slides deck (${requests.length} changes)`);
              return "Done.";
            }),
        }),
      );
  }

  // ── Company structure: departments, heads, managers (what this person may see of it) ──
  out.push(
    betaZodTool({
      name: "company_structure",
      description:
        "The company's departments (tree, with heads) and its people (title, department, manager, location; HR details only where this person may see them). " +
        "Use it for who someone reports to, who is in a department or team, who heads what, or 'my team'. person: a name or email to focus on.",
      inputSchema: z.object({ person: z.string().max(200).optional(), department: z.string().max(100).optional() }),
      run: async ({ person, department }) => {
        const { loadStructure } = await import("./structure");
        const st = await loadStructure(userId, workspaceId);
        live.step("Looked at the company structure");
        const name = (id: string | null) => {
          const p = st.people.find((x) => x.userId === id);
          return p ? p.name || p.email : null;
        };
        const path = (id: string | null) => {
          const out: string[] = [];
          for (let d = st.departments.find((x) => x.id === id); d && out.length < 8; d = st.departments.find((x) => x.id === d!.parentId)) out.unshift(d.name);
          return out.join(" › ") || null;
        };
        let people = st.people;
        if (person) {
          const q = person.toLowerCase();
          people = people.filter((p) => `${p.name ?? ""} ${p.email}`.toLowerCase().includes(q));
        }
        if (department) {
          const d = st.departments.find((x) => x.name.toLowerCase() === department.toLowerCase() || x.id === department);
          if (!d) return `No department called "${department}".`;
          const { subtree } = await import("./structure");
          const inside = subtree(st.departments, d.id);
          people = people.filter((p) => p.departmentId && inside.has(p.departmentId));
        }
        return plain(
          JSON.stringify({
            you: name(st.me),
            departments: st.departments.map((d) => ({ name: path(d.id), head: name(d.headId) })),
            people: people.slice(0, 300).map((p) => ({
              name: p.name || p.email,
              email: p.email,
              title: p.title,
              department: path(p.departmentId),
              manager: name(p.managerId),
              directReports: st.people.filter((x) => x.managerId === p.userId).map((x) => x.name || x.email),
              location: p.location,
              role: p.role,
              ...(p.hr ? { phone: p.phone, employeeCode: p.employeeCode, joinedOn: p.joinedOn } : {}),
            })),
          }),
          40_000,
        );
      },
    }),
  );

  // ── Work time and daily reports (People → Work time) ──
  out.push(
    betaZodTool({
      name: "work_time",
      description:
        "Work time. action 'status': this person's hours today and this week, clock state and today's report. action 'team': their team's hours and today's reports (admins: everyone). " +
        "action 'in' / 'out': clock this person in or out. action 'report': send today's daily report to their manager (done, next, blockers). Change things only when asked.",
      inputSchema: z.object({ action: z.enum(["status", "team", "in", "out", "report"]), done: z.string().max(4000).optional(), next: z.string().max(2000).optional(), blockers: z.string().max(2000).optional() }),
      run: async (i) => {
        const w = await import("./worktime");
        try {
          if (i.action === "status") {
            live.step("Checked work time");
            return JSON.stringify(await w.myWorkTime(userId, workspaceId));
          }
          if (i.action === "team") {
            live.step("Checked the team's work time");
            const t = await w.teamWorkTime(userId, workspaceId);
            const names = new Map((await db.user.findMany({ where: { id: { in: t.people.map((p) => p.userId) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name || u.email]));
            return JSON.stringify({ ...t, people: t.people.map((p) => ({ ...p, name: names.get(p.userId) })) });
          }
          if (i.action === "in" || i.action === "out") {
            const s = i.action === "in" ? await w.clockIn(userId, workspaceId) : await w.clockOut(userId, workspaceId);
            live.step(i.action === "in" ? "Clocked in" : "Clocked out");
            did(i.action === "in" ? "Clocked in" : "Clocked out");
            return i.action === "in" ? `Clocked in at ${s.startedAt.toISOString()}.` : `Clocked out at ${s.endedAt?.toISOString()}.`;
          }
          await w.saveReport(userId, workspaceId, { done: i.done, next: i.next, blockers: i.blockers });
          live.step("Sent the daily report");
          did("Sent the daily report");
          return "Daily report sent to their manager.";
        } catch (e) {
          if (e instanceof PermissionError) return e.message;
          throw e;
        }
      },
    }),
  );

  // ── Time off (People → Time off) ──
  out.push(
    betaZodTool({
      name: "time_off",
      description:
        "Time off. action 'away': who is on approved leave between from and to (YYYY-MM-DD). action 'mine': this person's requests and what waits for their approval. " +
        "action 'request': ask for time off for this person (type casual|sick|earned|wfh|unpaid|other, start, end, halfDay, reason); it goes to their manager for approval. Request only when they asked.",
      inputSchema: z.object({
        action: z.enum(["away", "mine", "request"]),
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
        type: z.enum(["casual", "sick", "earned", "wfh", "unpaid", "other"]).optional(),
        start: z.string().max(10).optional(),
        end: z.string().max(10).optional(),
        halfDay: z.boolean().optional(),
        reason: z.string().max(500).optional(),
      }),
      run: async (i) => {
        const t = await import("./timeoff");
        const name = async (id: string) => {
          const u = await db.user.findUnique({ where: { id }, select: { name: true, email: true } });
          return u?.name || u?.email || id;
        };
        if (i.action === "away") {
          const from = new Date(`${i.from ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
          const to = new Date(`${i.to ?? i.from ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
          if (Number.isNaN(+from) || Number.isNaN(+to)) return "from and to must be YYYY-MM-DD.";
          live.step("Checked who's away");
          const rows = await t.awayBetween(workspaceId, from, to);
          return JSON.stringify(await Promise.all(rows.map(async (r) => ({ person: await name(r.userId), type: r.type, start: r.startDate.toISOString().slice(0, 10), end: r.endDate.toISOString().slice(0, 10), halfDay: r.halfDay }))));
        }
        if (i.action === "mine") {
          live.step("Checked time off");
          const v = await t.timeOffView(userId, workspaceId, "");
          return JSON.stringify({
            approver: v.myApprover ? await name(v.myApprover) : "the workspace admins",
            takenThisYear: v.takenThisYear,
            mine: v.mine.slice(0, 20),
            waitingForMe: await Promise.all(v.waiting.map(async (w) => ({ ...w, person: await name(w.userId) }))),
          });
        }
        try {
          const r = await t.requestTimeOff(userId, workspaceId, { type: i.type, start: i.start, end: i.end ?? i.start, halfDay: i.halfDay, reason: i.reason });
          live.step(`Asked for time off ${r.startDate.toISOString().slice(0, 10)}`);
          did(`Asked for ${i.type} leave ${i.start}${i.end && i.end !== i.start ? ` to ${i.end}` : ""}`);
          return `Requested: ${r.days} ${r.days === 1 ? "day" : "days"}, waiting for ${r.approverId ? await name(r.approverId) : "an admin"} to approve.`;
        } catch (e) {
          if (e instanceof PermissionError) return e.message;
          throw e;
        }
      },
    }),
  );

  // ── Changing dashboards and folders (spaces checks the role and ownership) ──
  out.push(
    betaZodTool({
      name: "manage_space",
      description:
        "Change the sidebar's dashboards and folders: create one, rename, move into a folder, delete, add a Builder app (projectId from list_projects) or a link, or remove an item. " +
        "space and folder are names or ids (from suite_spaces); item is an item id from suite_spaces. Delete only when the person asked.",
      inputSchema: z.object({
        action: z.enum(["create_dashboard", "create_folder", "rename", "move", "delete", "add_app", "add_link", "remove_item"]),
        space: z.string().max(100).optional(),
        name: z.string().max(80).optional(),
        folder: z.string().max(100).optional().describe("The folder to create it in or move it to (empty to move to the top)"),
        projectId: z.string().max(60).optional(),
        url: z.string().max(500).optional(),
        title: z.string().max(120).optional(),
        item: z.string().max(60).optional(),
      }),
      run: async ({ action, space, name, folder, projectId, url, title, item }) => {
        const spaces = await import("./spaces");
        const v = await spaces.viewer(userId, workspaceId);
        const { spaces: list } = await spaces.sidebar(v);
        const find = (ref?: string) => (ref ? list.find((s) => s.id === ref) ?? list.find((s) => s.name.toLowerCase() === ref.toLowerCase()) : undefined);
        try {
          const target = find(space);
          const parent = folder ? find(folder) : undefined;
          if (folder && !parent) return `No folder "${folder}" in their sidebar.`;
          if (["rename", "move", "delete", "add_app", "add_link"].includes(action) && !target) return `No dashboard or folder "${space}" in their sidebar.`;
          let done = "";
          switch (action) {
            case "create_dashboard":
            case "create_folder": {
              const kind = action === "create_dashboard" ? "dashboard" : "folder";
              const s = await spaces.create(v, kind, name ?? "", parent?.id ?? null);
              done = `Created the ${kind} "${s.name}" (/spaces/${s.id})`;
              break;
            }
            case "rename":
              await spaces.rename(v, target!.id, name ?? "");
              done = `Renamed "${target!.name}" to "${name}"`;
              break;
            case "move":
              await spaces.move(v, target!.id, parent?.id ?? null);
              done = `Moved "${target!.name}" ${parent ? `into "${parent.name}"` : "to the top"}`;
              break;
            case "delete":
              await spaces.remove(v, target!.id);
              done = `Deleted "${target!.name}"`;
              break;
            case "add_app":
              await spaces.addItem(v, target!.id, { kind: "project", ref: projectId ?? "", title });
              done = `Added an app to "${target!.name}"`;
              break;
            case "add_link":
              await spaces.addItem(v, target!.id, { kind: "link", ref: url ?? "", title });
              done = `Added a link to "${target!.name}"`;
              break;
            case "remove_item":
              await spaces.removeItem(v, item ?? "");
              done = "Removed the item";
              break;
          }
          live.step(done);
          did(done);
          live.action({ kind: "shell" });
          if (target) live.action({ kind: "reload", match: `/spaces/${target.id}` });
          return `${done}. The sidebar shows it now.`;
        } catch (e) {
          if (e instanceof PermissionError) return e.message;
          throw e;
        }
      },
    }),
  );

  // ── Workspace: Tasks, Calendar, Team chat, Meet (apps/workspace, as this person) ──
  const ws = async (tool: string, input: Record<string, unknown>, step: string) => {
    live.step(step);
    const owner = (await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId } }, select: { role: true } }))?.role === "OWNER";
    const r = await fetch(`${WORKSPACE_INTERNAL}/api/internal/ai`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-iotx-key": process.env.IOTX_SERVICE_KEY ?? "" },
      body: JSON.stringify({ userId, ws: workspaceId, owner, perms: [...perms], tool, input }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!d) return "Workspace (Tasks, Calendar, Chat, Meet) didn't answer. Try again in a moment.";
    if (d.error) return `Workspace said: ${d.error}`;
    return plain(typeof d.result === "string" ? d.result : JSON.stringify(d.result), 30_000);
  };
  const wsTool = (name: string, description: string, inputSchema: z.ZodObject<z.ZodRawShape>, step: (i: Record<string, unknown>) => string, audited?: (i: Record<string, unknown>) => string) =>
    betaZodTool({
      name,
      description,
      inputSchema,
      run: async (i) => {
        const out = await ws(name, i as Record<string, unknown>, step(i as Record<string, unknown>));
        if (audited && !out.startsWith("Workspace said") && !out.startsWith("Workspace (")) did(audited(i as Record<string, unknown>));
        return out;
      },
    });
  const str = (n = 300) => z.string().max(n);
  if (["tasks.open", "calendar.open", "teamchat.open", "meetings.open"].some((k) => perms.has(k)))
    out.push(wsTool("workspace_people", "People in this workspace (id, name, email): to find who someone is before assigning, inviting or messaging them.", z.object({ q: str(100).optional() }), () => "Looked up people"));
  if (perms.has("tasks.open"))
    out.push(
      wsTool("task_projects", "The Tasks projects this person is in (id, key, name, workflow statuses).", z.object({}), () => "Listed task projects"),
      wsTool(
        "task_search",
        "Find tasks. Use `query` for the task query language (e.g. assignee = me AND status != Done) or the simple filters. Open tasks only unless open is false.",
        z.object({ text: str(200).optional(), query: str(400).optional(), projectId: str(60).optional(), mine: z.boolean().optional(), open: z.boolean().optional(), due: z.enum(["overdue", "today", "week", "none"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
        (i) => (i.text ? `Searched tasks for "${String(i.text).slice(0, 40)}"` : "Searched tasks"),
      ),
      wsTool("task_get", "One task in full by key (like MFU-39) or id: description, status, people, comments, links.", z.object({ key: str(60) }), (i) => `Read task ${i.key}`),
      ...(perms.has("tasks.create")
        ? [
            wsTool(
              "task_create",
              "Create a task. Do it straight away when asked; don't ask which project: leave projectId out and it goes to the company's default \"General\" project " +
                "(or give a project id, key or name). assignee: a name, email or id (default: the person asking). If the request is about an email, tab or chat, put its sender, subject and link in the description.",
              z.object({ projectId: str(60).optional(), title: str(300), description: str(20_000).optional(), assignee: str(200).optional(), due: str(40).optional().describe("YYYY-MM-DD"), priority: z.number().int().min(1).max(5).optional(), type: str(30).optional(), labels: z.array(str(40)).max(10).optional() }),
              (i) => `Created task: ${String(i.title).slice(0, 50)}`,
              (i) => `Created the task "${String(i.title).slice(0, 80)}"`,
            ),
          ]
        : []),
      wsTool(
        "task_update",
        "Change a task by key: title, description, status (a status name or id from the project's workflow), assignee (name/email; empty string to unassign), due (YYYY-MM-DD), priority.",
        z.object({ key: str(60), title: str(300).optional(), description: str(20_000).optional(), status: str(80).optional(), assignee: str(200).optional(), due: str(40).optional(), priority: z.number().int().min(1).max(5).optional() }),
        (i) => `Updated task ${i.key}`,
        (i) => `Updated task ${i.key}`,
      ),
      wsTool("task_comment", "Add a comment to a task by key.", z.object({ key: str(60), body: str(10_000) }), (i) => `Commented on ${i.key}`, (i) => `Commented on task ${i.key}`),
    );
  if (perms.has("calendar.open"))
    out.push(
      wsTool("calendar_events", "This person's calendar events between two times (ISO dates; at most three months).", z.object({ from: str(40), to: str(40) }), () => "Checked the calendar"),
      ...(perms.has("calendar.create")
        ? [
            wsTool(
              "calendar_create",
              "Create a calendar event. start/end are ISO date-times with offset (or dates with allDay). attendees: names or emails; colleagues get an invitation. " +
                "videoMeeting: true adds an IOTx Meet video call link to it (returned as meetingLink).",
              z.object({ title: str(300), start: str(40), end: str(40), allDay: z.boolean().optional(), videoMeeting: z.boolean().optional(), description: str(8000).optional(), location: str(300).optional(), attendees: z.array(str(200)).max(50).optional(), tz: str(60).optional() }),
              (i) => `Created event: ${String(i.title).slice(0, 50)}`,
              (i) => `Created the event "${String(i.title).slice(0, 80)}" at ${i.start}`,
            ),
            wsTool(
              "calendar_update",
              "Change an event by id (from calendar_events): title, description, location, start, end.",
              z.object({ id: str(80), title: str(300).optional(), description: str(8000).optional(), location: str(300).optional(), start: str(40).optional(), end: str(40).optional() }),
              () => "Updated an event",
              (i) => `Updated calendar event ${i.id}`,
            ),
            wsTool("calendar_delete", "Delete an event by id. Only when the person clearly asked to delete or cancel it.", z.object({ id: str(80) }), () => "Deleted an event", (i) => `Deleted calendar event ${i.id}`),
          ]
        : []),
    );
  if (perms.has("teamchat.open"))
    out.push(
      wsTool("chat_channels", "Team Chat channels and direct messages this person is in (id, name, unread).", z.object({}), () => "Listed chat channels"),
      wsTool("chat_read", "Recent messages in a Team Chat channel or DM (or one thread with threadId).", z.object({ channelId: str(80), threadId: str(80).optional(), limit: z.number().int().min(1).max(100).optional() }), () => "Read a chat channel"),
      wsTool("chat_search", "Search Team Chat messages this person can see.", z.object({ query: str(200) }), (i) => `Searched chat for "${String(i.query).slice(0, 40)}"`),
      wsTool(
        "chat_post",
        "Post a Team Chat message as this person: to a channel (channelId), a thread (threadId) or a direct message (`to`: a name or email). Only when they asked you to post or send it.",
        z.object({ channelId: str(80).optional(), threadId: str(80).optional(), to: str(200).optional(), body: str(12_000) }),
        () => "Posted in Team Chat",
        (i) => `Posted a Team Chat message${i.to ? ` to ${i.to}` : ""}`,
      ),
    );
  if (perms.has("meetings.open"))
    out.push(
      ...(perms.has("meetings.create")
        ? [
            wsTool(
              "meeting_create",
              "Make an IOTx Meet video call link right now (a room people join from the link). invite: names or emails of colleagues to notify. For a call at a set time, use calendar_create with videoMeeting instead.",
              z.object({ title: str(200).optional(), invite: z.array(str(200)).max(50).optional() }),
              () => "Created a meeting link",
              (i) => `Created a Meet link${i.title ? ` for "${String(i.title).slice(0, 60)}"` : ""}`,
            ),
          ]
        : []),
      wsTool("meetings_search", "Search past meetings (title, people, dates) this person can see.", z.object({ query: str(200).optional(), from: str(40).optional().describe("YYYY-MM-DD"), to: str(40).optional().describe("YYYY-MM-DD"), limit: z.number().int().min(1).max(50).optional() }), () => "Searched meetings"),
      wsTool("meeting_report", "A meeting's report: summary, decisions, action items and notes (meeting: the id or code from meetings_search).", z.object({ meeting: str(80), transcript: z.boolean().optional() }), () => "Read a meeting report"),
      wsTool("meeting_action_items", "Action items from recent meetings.", z.object({ days: z.number().int().min(1).max(90).optional(), mine: z.boolean().optional() }), () => "Checked meeting action items"),
    );

  // ── Mail (the mailboxes this person can open in the Mail app) ──
  if (perms.has("mail.open")) {
    out.push(
      betaZodTool({
        name: "list_mail",
        description:
          "List emails, newest first, from the person's mailboxes in the Mail app: sender, subject, a short preview, date and whether it's read. " +
          'Use it for "my latest email", "anything from Priya?", "unread mail". Then read_mail for the full text.',
        inputSchema: z.object({
          query: z.string().max(200).optional().describe("Words to match in the sender, subject or preview"),
          unreadOnly: z.boolean().optional(),
          folder: z.string().max(200).optional().describe("Default INBOX"),
          limit: z.number().int().min(1).max(30).optional(),
          refresh: z.boolean().optional().describe("Check the mail server for new mail first (slower)"),
        }),
        run: async ({ query, unreadOnly, folder = "INBOX", limit = 10, refresh }) => {
          const boxes = await mailboxesFor(userId, workspaceId);
          if (!boxes.length) return "No mailbox is connected. The person can connect one in the Mail app (Gmail, or any IMAP account).";
          const q = query?.trim();
          live.step(q ? `Searched mail for "${q.slice(0, 40)}"` : "Checked the inbox");
          const lists = await Promise.all(
            boxes.map(async (m) => {
              const known = await db.mailMessage.count({ where: { mailboxId: m.id, folder } });
              if (refresh || !known) await syncFolder(m, folder).catch(() => undefined);
              const rows = await db.mailMessage.findMany({
                where: {
                  mailboxId: m.id,
                  folder,
                  ...(unreadOnly ? { seen: false } : {}),
                  ...(q
                    ? { OR: [{ subject: { contains: q, mode: "insensitive" } }, { fromAddr: { contains: q, mode: "insensitive" } }, { fromName: { contains: q, mode: "insensitive" } }, { snippet: { contains: q, mode: "insensitive" } }] }
                    : {}),
                },
                orderBy: { date: "desc" },
                take: limit,
                select: { id: true, fromAddr: true, fromName: true, subject: true, snippet: true, date: true, seen: true, hasAttachments: true },
              });
              return rows.map((r) => ({ mailboxId: m.id, mailbox: m.email, ...r }));
            }),
          );
          const all = lists.flat().sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, limit);
          if (!all.length) return q ? `No email in ${folder} matches "${q}".` : `${folder} is empty.`;
          return JSON.stringify(all.map((r) => ({ ...r, date: r.date.toISOString(), snippet: (r.snippet ?? "").slice(0, 200) })));
        },
      }),
      betaZodTool({
        name: "read_mail",
        description: "Read one email in full (its mailboxId and id come from list_mail). Reading it doesn't mark it as read.",
        inputSchema: z.object({ mailboxId: z.string(), id: z.string() }),
        run: async ({ mailboxId, id }) => {
          const m = (await mailboxesFor(userId, workspaceId)).find((x) => x.id === mailboxId);
          if (!m) return "That mailbox isn't one this person can open.";
          const msg = await openMessage(m, id).catch(() => null);
          if (!msg) return "Email not found. Call list_mail again.";
          live.step(`Read email: ${(msg.subject || "(no subject)").slice(0, 50)}`);
          const to = ((msg.to as { address?: string }[] | null) ?? []).map((x) => x.address).join(", ");
          return `From: ${msg.fromName ? `${msg.fromName} <${msg.fromAddr}>` : msg.fromAddr}\nTo: ${to}\nDate: ${msg.date.toISOString()}\nSubject: ${msg.subject}\n\n${bodyOf(msg)}`;
        },
      }),
    );
  }
  return out;
}

/** The system prompt's part about the suite tools. */
export const SUITE_PROMPT = `You can also work across the suite:
- Open tabs: when the person refers to another tab ("tab 3", "the Builder", "that email"), use list_open_tabs and read_tab. To put text into a tab (a prompt, an email, a field), use fill_tab; it fills but never submits. Never open a tab in order to read it: a tab you open appears only after your reply, so read the data with the matching tool instead (list_mail, read_sheet, project_details…).
- Google Sheets, Docs and Slides: find, read, create and edit the person's files directly with the office tools. A tab at /sheets/<id>, /docs/<id> or /slides/<id> has that file open: use its id with read_sheet, read_doc or read_slides (a tab's text alone misses the grid). Read before you edit, and say what you changed; the open tab reloads by itself.
- When asked to create or change something (a task, an event, a message), do it with sensible defaults and report what you did; ask only if something essential is truly missing.
- Tasks, Calendar, Team Chat and Meet: use the task_*, calendar_*, chat_* and meeting* tools directly (meeting links come from IOTx Meet: calendar_create with videoMeeting, or meeting_create) (workspace_people to find someone). You act as the person with their role's permissions; post, create, change or delete only what they asked for, and say what you did.
- Work time: work_time clocks this person in or out, sends their daily report, and shows their or their team's hours.
- Time off: time_off shows who is away and this person's requests, and asks for leave for them (their manager approves).
- People: company_structure answers who reports to whom, who heads or works in a department, and \"my team\".
- Dashboards and folders: suite_spaces reads them; manage_space creates, renames, moves, deletes and fills them.
- Mail: list_mail and read_mail read the person's connected mailboxes ("my latest email", "unread from Priya"). You can't send mail; to draft one, fill_tab into an open Mail compose tab.
- Dashboards and folders: the sidebar ones are listed by suite_spaces; an app inside one is a project (use project_details).
- Memory: you remember things across conversations. Save lasting facts with remember; fix wrong ones with forget.
- The web: when web_search is available, use it for current facts, prices, news or anything outside the company, and cite the sources.`;
