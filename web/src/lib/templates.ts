/**
 * Templates are seed prompts, not checked-in source. The generator already
 * writes the whole project, so storing a brief keeps every template current
 * with the engine instead of rotting as a copied file tree.
 */
export type Category = "Landing pages" | "Productivity" | "Business" | "E-commerce" | "Portfolio" | "Data";

export type Template = {
  slug: string;
  name: string;
  category: Category;
  blurb: string;
  designedFor: string;
  features: string[];
  prompt: string;
};

export const CATEGORIES: Category[] = ["Landing pages", "Productivity", "Business", "E-commerce", "Portfolio", "Data"];

/** Style direction appended when remixing a template. */
export const STYLES: Record<string, string> = {
  minimal: "Minimal — lots of white space, a restrained neutral palette, one accent colour, clean sans-serif type.",
  bold: "Bold — saturated colours, large confident headlines, strong contrast and blocky sections.",
  playful: "Playful — rounded shapes, friendly colours, soft shadows and a bit of motion.",
  elegant: "Elegant — a serif display face, muted earthy palette, generous spacing and fine borders.",
};

export const TEMPLATES: Template[] = [
  {
    slug: "saas-landing",
    name: "SaaS landing page",
    category: "Landing pages",
    blurb: "Hero, feature grid, social proof, pricing and FAQ.",
    designedFor: "Founders launching a software product.",
    features: ["Hero with product screenshot", "Feature grid", "Logo wall and testimonials", "Three-tier pricing", "FAQ accordion"],
    prompt:
      "Build a landing page for a SaaS product: a hero with headline, subheading, primary and secondary CTAs and a generated product screenshot; a six-item feature grid with icons; a logo wall and three testimonials; three pricing tiers with a monthly/annual toggle; an FAQ accordion; and a footer. Make it fully responsive.",
  },
  {
    slug: "local-business",
    name: "Local business site",
    category: "Landing pages",
    blurb: "Services, opening hours, map placeholder and a booking form.",
    designedFor: "Cafés, salons, studios and clinics.",
    features: ["Services with prices", "Opening hours", "Gallery of generated photos", "Booking request form with toast"],
    prompt:
      "Build a website for a local business: hero with a generated photo, services with prices, an about section, a photo gallery, opening hours, a location section, and a booking request form that validates and shows a toast on submit.",
  },
  {
    slug: "task-board",
    name: "Task board",
    category: "Productivity",
    blurb: "Kanban columns with per-column counts.",
    designedFor: "Small teams tracking work.",
    features: ["To do / In progress / Done columns", "Move cards between columns", "Priorities and notes", "Seeded sample tasks"],
    prompt:
      "Build a task board with three columns (To do, In progress, Done). Each card has a title, an optional note and a priority badge. Cards move between columns with buttons on the card. Show a count per column, support adding and deleting cards, and seed six realistic sample tasks.",
  },
  {
    slug: "habit-tracker",
    name: "Habit tracker",
    category: "Productivity",
    blurb: "A weekly grid with streak counts.",
    designedFor: "Anyone building routines.",
    features: ["Weekly completion grid", "Streak per habit", "Weekly completion rate", "Add and remove habits"],
    prompt:
      "Build a habit tracker showing habits down the side and the last 7 days across the top. Clicking a cell toggles completion. Show a current streak per habit and a completion percentage for the week. Support adding and removing habits. Seed four sample habits with plausible history.",
  },
  {
    slug: "invoice-builder",
    name: "Invoice builder",
    category: "Business",
    blurb: "Line items, tax and totals, formatted for printing.",
    designedFor: "Freelancers and small businesses.",
    features: ["Editable business and client details", "Line items with computed amounts", "Tax and totals", "Print-ready layout"],
    prompt:
      "Build an invoice builder. Editable business and client blocks, a line-item table where each row has description, quantity and unit price with a computed amount, add/remove rows, a tax-rate field, and computed subtotal, tax and total. Include an invoice number and date. Style it so it looks correct when printed.",
  },
  {
    slug: "crm-lite",
    name: "Lightweight CRM",
    category: "Business",
    blurb: "Contacts, deal pipeline and activity notes.",
    designedFor: "Small sales teams.",
    features: ["Contact list with search", "Deal pipeline by stage", "Activity notes per contact", "Pipeline value totals"],
    prompt:
      "Build a lightweight CRM: a searchable contacts table, a contact detail page with an activity notes timeline, and a deal pipeline view with stages (Lead, Qualified, Proposal, Won, Lost) showing deal value per stage. Use react-router for the pages and seed realistic sample data.",
  },
  {
    slug: "survey-form",
    name: "Multi-step form",
    category: "Business",
    blurb: "A staged form with validation and a review step.",
    designedFor: "Onboarding, applications and surveys.",
    features: ["Progress indicator", "Validation per step", "Review before submit", "Success state"],
    prompt:
      "Build a four-step form: contact details, preferences, feedback, and a review step that summarizes every answer before submission. Show a progress indicator, validate each step before advancing, allow going back without losing data, and show a success state after submitting.",
  },
  {
    slug: "online-store",
    name: "Online store",
    category: "E-commerce",
    blurb: "Product grid, product pages and a cart drawer.",
    designedFor: "Small shops selling physical products.",
    features: ["Product grid with filters", "Product detail pages", "Cart drawer with quantities", "Order summary"],
    prompt:
      "Build an online store: a product grid with category filters and sorting, product detail pages with generated product images, an add-to-cart flow with a slide-in cart drawer (quantities, remove, subtotal), and an order summary page. Use react-router and seed eight products.",
  },
  {
    slug: "pricing-page",
    name: "Pricing page",
    category: "E-commerce",
    blurb: "Three tiers with a monthly/annual toggle.",
    designedFor: "Subscription products.",
    features: ["Monthly/annual toggle", "Feature comparison", "Recommended tier", "FAQ"],
    prompt:
      "Build a pricing page with three tiers (Starter, Growth, Scale), a monthly/annual billing toggle that updates all prices and shows the annual saving, a feature comparison list per tier, a highlighted recommended tier, and an FAQ section below. Make it fully responsive.",
  },
  {
    slug: "portfolio",
    name: "Personal portfolio",
    category: "Portfolio",
    blurb: "Projects, about, experience and contact.",
    designedFor: "Designers, developers and creatives.",
    features: ["Project case-study cards", "About and experience timeline", "Contact form", "Generated project imagery"],
    prompt:
      "Build a personal portfolio: a hero introducing the person, a grid of project case studies with generated cover images that open detail pages, an about section with an experience timeline, and a contact form with a toast on submit. Use react-router.",
  },
  {
    slug: "analytics-dashboard",
    name: "Analytics dashboard",
    category: "Data",
    blurb: "KPI tiles, trend and bar charts, activity table.",
    designedFor: "Teams watching their numbers.",
    features: ["KPI tiles with change vs last period", "30-day trend chart", "Top sources bar chart", "Date-range selector"],
    prompt:
      "Build an analytics dashboard with four KPI tiles (value, label, change versus last period), a line chart of the last 30 days, a bar chart of top sources, and a recent-activity table. Add a date-range selector that changes the seeded data. Add recharts to the dependencies for the charts.",
  },
  {
    slug: "event-rsvp",
    name: "Event invite with RSVP",
    category: "Landing pages",
    blurb: "Event details, countdown and an RSVP form.",
    designedFor: "Parties, launches and meetups.",
    features: ["Countdown timer", "Schedule and location", "RSVP form with guest count", "Guest list summary"],
    prompt:
      "Build an event invitation page: a hero with the event name and a live countdown, schedule and location sections, an RSVP form (name, email, attending yes/no, number of guests) that validates and shows a toast, and a running summary of responses kept in local state.",
  },
];

/**
 * Templates that were retired. Old links keep working: a replaced template
 * redirects to its successor with a notice; a removed one explains itself.
 */
export const RETIRED_TEMPLATES: Record<string, { name: string; replacedBy: string | null }> = {
  "landing-page": { name: "Landing page", replacedBy: "saas-landing" },
  "todo-app": { name: "To-do app", replacedBy: "task-board" },
  "blog": { name: "Blog", replacedBy: null },
};

/** Who each template is for, for the gallery's persona filter. */
export const PERSONAS: Record<string, string[]> = {
  Founders: ["saas-landing", "pricing-page", "analytics-dashboard"],
  "Small businesses": ["local-business", "invoice-builder", "online-store", "crm-lite"],
  Teams: ["task-board", "crm-lite", "analytics-dashboard", "survey-form"],
  "Freelancers & creatives": ["portfolio", "invoice-builder"],
  Personal: ["habit-tracker", "event-rsvp"],
};
export const personasOf = (slug: string) => Object.keys(PERSONAS).filter((p) => PERSONAS[p].includes(slug));

export function findTemplate(slug: string) {
  return TEMPLATES.find((t) => t.slug === slug);
}
