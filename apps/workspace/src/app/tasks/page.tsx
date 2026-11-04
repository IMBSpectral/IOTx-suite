import type { Metadata } from "next";
import { boot, Frame } from "@/lib/page";
import NoAccess from "@/components/NoAccess";
import TasksApp from "@/components/tasks/TasksApp";
import "./tasks.css";
import "./tasks-board.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tasks" };

export default async function Page() {
  const r = await boot("tasks", "/tasks");
  if ("el" in r) return r.el;
  return (
    <Frame shell={r.shell} active="tasks" me={r.me}>
      {r.me.perms["tasks.open"] ? <TasksApp boot={r.boot} /> : <NoAccess name="Tasks" />}
    </Frame>
  );
}
