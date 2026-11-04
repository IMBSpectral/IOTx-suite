import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { shellData } from "@/lib/iotx/shell";
import { manifestById } from "@/lib/iotx/manifests";
import { listProjects } from "@/lib/projects";
import { listDocs, viewer } from "@/lib/kb";
import Shell from "@/components/iotx/Shell";
import StartPage, { type Recent } from "@/components/iotx/StartPage";

const color = (id: string) => manifestById(id)?.color ?? "#6a6e8a";

/**
 * IOTx Suite Home: the New Tab page (search everything and ask the AI,
 * shortcuts, recent work), filtered by the person's permissions.
 * ?prompt= pre-fills the search box.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ prompt?: string }> }) {
  const session = await auth();
  const userId = session!.user!.id;
  const data = await shellData(userId);
  if (!data) redirect("/welcome");
  const { prompt } = await searchParams;
  const opens = (app: string) => !data.perms || data.perms.apps.includes(app);
  const can = (key: string) => !data.perms || data.perms.keys.includes(key);
  const ws = data.workspace.id;

  // What's cheap to know here: projects opened lately, AI chats, knowledge articles.
  const [projects, chats, articles] = await Promise.all([
    opens("builder") ? listProjects({ userId, workspaceId: ws, view: "recent", take: 4 }).catch(() => []) : [],
    can("home.ask") ? db.workspaceChat.findMany({ where: { userId, workspaceId: ws }, orderBy: { updatedAt: "desc" }, take: 4, select: { id: true, title: true, updatedAt: true } }) : [],
    opens("read")
      ? viewer(userId, ws)
          .then((v) => listDocs(v))
          .then((d) => d.slice(0, 3))
          .catch(() => [])
      : [],
  ]);
  const recent: Recent[] = [
    ...projects.map((p) => ({ key: `p${p.id}`, label: p.name, sub: "Builder", href: `/projects/${p.id}`, icon: "builder", color: color("builder"), at: new Date(p.updatedAt).toISOString() })),
    ...chats.map((c) => ({ key: `c${c.id}`, label: c.title, sub: "AI Chat", href: `/home/chat?chat=${c.id}`, icon: "chat", color: color("chat"), at: c.updatedAt.toISOString() })),
    ...articles.map((d) => ({ key: `k${d.id}`, label: d.title, sub: "Knowledge", href: `/knowledge?doc=${d.id}`, icon: "read", color: color("read"), at: d.updatedAt.toISOString() })),
  ];

  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data}>
        <StartPage initialQuery={(prompt ?? "").slice(0, 400)} recent={recent} userKey={userId} />
      </Shell>
    </main>
  );
}
