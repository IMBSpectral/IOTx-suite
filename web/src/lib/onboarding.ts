/**
 * Onboarding ("enterprise onboarding"): pick your role and the tasks that
 * fill your week, then see a preview of the workspace: one starter app per
 * task, ready to build with a click.
 */

export type Starter = { task: string; name: string; prompt: string };

export const ROLES: Record<string, Starter[]> = {
  "Product management": [
    { task: "Collecting customer feedback", name: "Feedback board", prompt: "A feedback board where customers submit ideas, vote, and comment; admins tag and set statuses (planned, in progress, done)." },
    { task: "Writing specs and roadmaps", name: "Roadmap", prompt: "A public roadmap with Now / Next / Later columns, items with descriptions and target quarters, and a changelog page." },
    { task: "Tracking launch metrics", name: "Launch dashboard", prompt: "A launch metrics dashboard with sign-ups, activation and retention charts, date filters and a CSV import for data." },
    { task: "Running user interviews", name: "Interview tracker", prompt: "A user-interview tracker: schedule interviews, record notes and tags, and see the most common themes." },
  ],
  Engineering: [
    { task: "Triaging bugs", name: "Bug triage", prompt: "A bug triage board: report bugs with severity and steps, assign owners, filter by status and component." },
    { task: "On-call and incidents", name: "Incident log", prompt: "An incident log with severity, timeline entries, owner and postmortem notes, plus a status page view." },
    { task: "Internal tools", name: "Admin panel", prompt: "An internal admin panel with a searchable users table, user detail pages and an audit log of changes." },
    { task: "Release notes", name: "Release notes", prompt: "A release notes site: entries by version with tags (feature, fix, improvement) and an RSS feed." },
  ],
  Design: [
    { task: "Sharing work for review", name: "Design review", prompt: "A design review board: upload screens, leave pinned comments, mark feedback resolved." },
    { task: "Maintaining a design system", name: "Component catalog", prompt: "A component catalog documenting buttons, inputs and cards with usage notes and live examples." },
    { task: "Showing a portfolio", name: "Portfolio", prompt: "A portfolio site with case studies, an about page and a contact form." },
  ],
  Marketing: [
    { task: "Launching campaigns", name: "Campaign landing page", prompt: "A campaign landing page with a hero, benefits, testimonials, pricing and a waitlist sign-up form." },
    { task: "Planning content", name: "Content calendar", prompt: "A content calendar: posts by channel and date, status (idea, drafting, scheduled, published), owners." },
    { task: "Tracking leads", name: "Lead tracker", prompt: "A lead tracker with sources, stages and a simple funnel chart." },
    { task: "Running events", name: "Event RSVP", prompt: "An event page with agenda, speakers and an RSVP form that collects attendees." },
  ],
  Sales: [
    { task: "Managing deals", name: "Deal pipeline", prompt: "A sales pipeline with deals by stage, values, close dates, notes and a forecast total." },
    { task: "Preparing quotes", name: "Quote builder", prompt: "A quote builder: line items, discounts, tax, a shareable quote page and PDF download." },
    { task: "Keeping account notes", name: "Account notes", prompt: "A lightweight CRM: accounts, contacts, meeting notes and next steps." },
  ],
  Operations: [
    { task: "Tracking requests", name: "Request tracker", prompt: "An internal request tracker: submit requests, assign, set due dates, and see what's overdue." },
    { task: "Managing inventory", name: "Inventory", prompt: "An inventory app with items, stock levels, low-stock alerts and a movements log." },
    { task: "Onboarding new hires", name: "Onboarding checklist", prompt: "An onboarding checklist per new hire with tasks by week, owners and progress." },
  ],
  "Customer support": [
    { task: "Answering tickets", name: "Help desk", prompt: "A help desk: customers open tickets, agents reply, set priority and status, and see response times." },
    { task: "Writing help articles", name: "Help center", prompt: "A help center with categories, searchable articles and 'Was this helpful?' votes." },
  ],
  "Founder or executive": [
    { task: "Pitching the company", name: "Company site", prompt: "A company website with a strong hero, product overview, team and a contact form." },
    { task: "Reporting to the team", name: "KPI dashboard", prompt: "A KPI dashboard with revenue, customers and burn, monthly trends and notes." },
    { task: "Hiring", name: "Careers page", prompt: "A careers page with open roles, role detail pages and an application form." },
  ],
};

export const roleNames = Object.keys(ROLES);
export const startersFor = (role: string, tasks: string[]) => (ROLES[role] ?? []).filter((s) => tasks.includes(s.task));
