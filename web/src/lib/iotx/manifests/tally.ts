import type { AppManifest } from "../types";

/** The accounts ledger (apps/tally). Vouchers become a type x action matrix of switches. */
export const tally: AppManifest = {
  id: "tally",
  name: "Accounts",
  desc: "Accounts & GST",
  color: "linear-gradient(135deg,#b45309,#facc15)",
  icon: "ledger",
  status: "soon",
  mountPath: "/tally",
  source: "apps/tally",
  order: 5,
  vouchers: {
    types: ["Sales", "Purchase", "Receipt", "Payment", "Journal", "Contra", "Credit note", "Debit note"],
    actions: ["create", "alter", "delete", "approve"],
  },
  features: [
    { key: "tally.company.view", label: "Open assigned companies", group: "Companies" },
    { key: "tally.company.create", label: "Create companies", group: "Companies", risk: true },
    { key: "tally.masters.view", label: "View ledgers, groups and stock items", group: "Masters" },
    { key: "tally.masters.create", label: "Create masters", group: "Masters" },
    { key: "tally.masters.alter", label: "Alter masters", group: "Masters" },
    { key: "tally.masters.delete", label: "Delete masters", group: "Masters", risk: true },
    { key: "tally.reports.daybook", label: "Day book", group: "Reports" },
    { key: "tally.reports.trial", label: "Trial balance", group: "Reports" },
    { key: "tally.reports.pl", label: "Profit and loss", group: "Reports" },
    { key: "tally.reports.bs", label: "Balance sheet", group: "Reports" },
    { key: "tally.reports.gst", label: "GST returns", group: "Reports" },
    { key: "tally.reports.stock", label: "Stock summary", group: "Reports" },
    { key: "tally.amount_limit", label: "Largest voucher amount", group: "Controls", type: "limit", unit: "INR", hint: "Empty means no limit" },
    { key: "tally.backdate", label: "Back-dated entries up to", group: "Controls", type: "limit", unit: "days" },
    { key: "tally.period_unlock", label: "Unlock a closed period", group: "Controls", risk: true, defaults: ["owner"] },
    { key: "tally.audit", label: "View audit trail", group: "Controls" },
    { key: "tally.export", label: "Export data", group: "Controls" },
  ],
  scopes: [
    { key: "tally.company", label: "Companies", options: ["All companies", "Assigned per person"] },
    { key: "tally.branch", label: "Branches", options: ["All branches", "Assigned per person"] },
  ],
  roadmap: [
    "Sign in through IOTx with a short-lived pass",
    "Companies and branches as data scopes",
    "Voucher switches, amount and back-dating limits, period locks",
  ],
};
