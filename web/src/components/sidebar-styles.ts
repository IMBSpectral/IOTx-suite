/**
 * Shared look for every sidebar row: 32px tall, icon + label. A plain module
 * (not "use client") so server components get the string itself, not a
 * client reference.
 */
export const SIDEBAR_ROW =
  "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.06]";
