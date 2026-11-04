import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getBrand } from "@/lib/brand";
import { shellData } from "@/lib/iotx/shell";
import Shell from "@/components/iotx/Shell";
import ChatView from "@/components/iotx/ChatView";

/** AI Chat inside the shell (?chat=<id> opens one; ?prompt=…&send=1 starts one). */
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ chat?: string; prompt?: string; send?: string }> }) {
  const session = await auth();
  const data = await shellData(session!.user!.id);
  if (!data) redirect("/welcome");
  const { chat, prompt, send } = await searchParams;
  const brand = getBrand();
  const allowed = !data.perms || data.perms.keys.includes("home.ask");
  return (
    <main className="app-editor flex-1" style={{ minWidth: 0 }}>
      <Shell data={data} active="chat" activeChat={chat ?? null}>
        {allowed ? (
          <ChatView key={chat ?? "new"} chatId={chat ?? null} prompt={(prompt ?? "").slice(0, 4000)} autoSend={send === "1"} />
        ) : (
          <div className="ix-soon">
            <h1>Asking {brand.shortName} isn&apos;t on for your role</h1>
            <p style={{ color: "var(--ix-muted)" }}>Ask an admin to turn on &quot;Ask {brand.shortName}&quot; under Roles &amp; permissions.</p>
          </div>
        )}
      </Shell>
    </main>
  );
}
