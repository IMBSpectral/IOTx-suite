"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  CircleHelp,
  FolderClosed,
  House,
  Paperclip,
  MessagesSquare,
  Plus,
  Repeat,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { SIDEBAR_ROW } from "./sidebar-styles";

const ICONS: Record<string, LucideIcon> = {
  new: Plus,
  home: House,
  assistant: Bot,
  projects: FolderClosed,
  chats: MessagesSquare,
  files: Paperclip,
  automations: Repeat,
  settings: Settings,
  help: CircleHelp,
};

export default function SidebarLink({
  href,
  label,
  icon,
  exact = false,
}: {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  exact?: boolean;
}) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  const Icon = ICONS[icon];
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`${SIDEBAR_ROW} ${active ? "bg-black/[.06] font-medium dark:bg-white/[.08]" : ""}`}
    >
      <Icon className="h-4 w-4 shrink-0" style={{ color: active ? "var(--text)" : "var(--muted)" }} />
      <span className="truncate">{label}</span>
    </Link>
  );
}
