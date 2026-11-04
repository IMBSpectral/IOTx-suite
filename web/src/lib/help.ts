/** Help center articles. Short, task-focused, searchable. */
export type Article = { slug: string; title: string; section: string; body: string; keywords: string };

export const ARTICLES: Article[] = [
  {
    slug: "modes",
    title: "Build, Plan, Ask and Design modes",
    section: "Chat",
    keywords: "mode chat build plan ask design switch",
    body: "Build changes your app. Plan drafts a plan you approve before anything is built. Ask answers questions without editing files. Design focuses on look and feel. Switch modes under the message box or type /plan, /ask, /build or /design.",
  },
  {
    slug: "queue",
    title: "Queueing messages and stopping a turn",
    section: "Chat",
    keywords: "queue stop pause reorder cancel running",
    body: "Messages you send while the agent is working wait in a queue. You can run one now, edit it, remove it, pause the queue or clear it. Stop ends the running turn; work already done is kept in a draft.",
  },
  {
    slug: "drafts",
    title: "Drafts: review before changes go live",
    section: "Versions",
    keywords: "draft accept discard revert version history undo",
    body: "Each build lands in a draft. Accept it to make it the current version, or discard it. History lists every version; restore any of them, bookmark important ones, and undo or redo the last change from the chat.",
  },
  {
    slug: "attachments",
    title: "Attach images, PDFs and documents",
    section: "Chat",
    keywords: "attach image screenshot pdf file paste drop upload",
    body: "Click the paperclip, paste, or drag files into the message box. The agent can read images, PDFs and text files, and can save attachments into the project.",
  },
  {
    slug: "visual-edit",
    title: "Select an element in the preview",
    section: "Preview",
    keywords: "select element visual edit inspector click preview",
    body: "Turn on Select above the preview and click an element. The next message is about that element, so you can say what to change without describing where it is.",
  },
  {
    slug: "publishing",
    title: "Publish your app",
    section: "Publishing",
    keywords: "publish deploy live url subdomain domain unpublish seo badge",
    body: "Publish runs checks (build, security, dependencies, SEO), builds the current version and puts it live at your subdomain. Choose who can open it, edit its search and social appearance, hide the badge, or unpublish at any time.",
  },
  {
    slug: "sharing",
    title: "Share a project and preview links",
    section: "Collaboration",
    keywords: "share invite collaborator role restricted link preview password expire request access",
    body: "Open Share to invite people as Admin, Can edit or Can view, restrict a project to invited people, or turn on an invite link. Preview links let anyone without an account see the current version, with an optional password and expiry.",
  },
  {
    slug: "security",
    title: "Security scan and fixes",
    section: "Security",
    keywords: "security scan findings fix ignore vulnerabilities dependencies audit",
    body: "The Security tab scans your code and dependencies. Fix sends a free fix to the agent; Ignore needs a reason and can be undone. Publishing is blocked by critical findings.",
  },
  {
    slug: "credits",
    title: "Credits, limits and usage",
    section: "Billing",
    keywords: "credits billing usage limit spend top up plan out of credits",
    body: "Builds, chat and generated images use credits. Settings → Billing shows your balance, where credits went this month, and spending limits for the workspace, members and projects.",
  },
  {
    slug: "import",
    title: "Import from GitHub, a ZIP or a website",
    section: "Projects",
    keywords: "import github gitlab zip website bolt v0 replit",
    body: "On the dashboard, choose Import. Paste a public repository URL, upload a ZIP, or enter a website address to rebuild it. Guides cover moving from other builders.",
  },
  {
    slug: "knowledge",
    title: "Knowledge and memory",
    section: "Agent",
    keywords: "knowledge memory instructions context remember",
    body: "Project Knowledge is included in every turn: describe your audience, style and rules there. The agent can also remember facts it learns while working.",
  },
];

function tokens(s: string) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function searchHelp(query: string) {
  const q = tokens(query);
  if (!q.length) return ARTICLES;
  return ARTICLES.map((a) => {
    const title = tokens(a.title + " " + a.keywords);
    const body = tokens(a.body);
    const score = q.reduce(
      (n, w) => n + (title.some((t) => t.startsWith(w)) ? 3 : 0) + (body.some((t) => t.startsWith(w)) ? 1 : 0),
      0,
    );
    return { a, score };
  })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}
