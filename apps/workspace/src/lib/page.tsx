import { headers } from "next/headers";
import { getMe, passUrl, type AppId, type Me } from "./auth";
import { SUITE_PUBLIC_URL } from "./env";
import Bounce from "@/components/Bounce";
import SuiteFrame from "@/components/suite/SuiteFrame";
import { db } from "./db";
import { people } from "./calendar";
import { standinShell, suiteShell, type SuiteShell } from "./suite";

export type Boot = {
  me: { id: string; name: string; email: string; tz: string; ws: string; owner: boolean; perms: Record<string, boolean>; guest?: boolean };
  suite: string;
  people: { id: string; name: string; email: string; image: string | null }[];
};

/**
 * For pages: the signed-in person and the suite shell, or a bounce through
 * the suite for a (fresh) pass. Returns either a React element to render
 * as-is, or the boot data.
 */
export async function boot(app: AppId, path: string): Promise<{ el: React.ReactElement } | { boot: Boot; me: Me; shell: SuiteShell }> {
  const me = await getMe();
  // The suite is a browser and these pages are its tabs. Opened on their own (a bookmark, a shared
  // link, a refresh of the suite on this page), they go into the suite's frame as a tab. Guests keep
  // their own Chat page (GuestFrame): they have no suite.
  if (!me?.guest && (await headers()).get("sec-fetch-dest") === "document") return { el: <ToSuite /> };
  if (!me || me.stale) return { el: <Bounce to={passUrl(app, path)} /> };
  if (me.guest && app !== "teamchat") return { el: <GuestOnly /> };
  const [shell, all] = await Promise.all([me.guest ? standinShell(me) : suiteShell(me.userId, me.ws, { name: me.name, email: me.email }), people(me.ws)]);
  const ppl = app === "teamchat" ? await chatPeople(me, all) : all.filter((p) => !/^(guest|bot)_/.test(p.id));
  await db.member.update({ where: { ws_userId: { ws: me.ws, userId: me.userId } }, data: { seenAt: new Date() } }).catch(() => {});
  return {
    me,
    shell,
    boot: {
      me: { id: me.userId, name: me.name, email: me.email, tz: me.tz, ws: me.ws, owner: me.owner, perms: me.perms, guest: me.guest },
      suite: SUITE_PUBLIC_URL,
      people: ppl,
    },
  };
}

type Person = Boot["people"][number];

/**
 * Chat's people: guests ("guest_…") and bots ("bot_…") are members too, and
 * workflows ("wf_…") are added so their DMs have a name. A guest only sees
 * the people in their own channels.
 */
async function chatPeople(me: Me, all: Person[]): Promise<Person[]> {
  const wfs = await db.chatWorkflow.findMany({ where: { ws: me.ws }, select: { id: true, name: true } });
  const list = [...all, ...wfs.map((w) => ({ id: `wf_${w.id}`, name: w.name, email: "", image: null }))];
  if (!me.guest) return list;
  const mine = await db.channelMember.findMany({ where: { userId: me.userId }, select: { channelId: true } });
  const near = new Set((await db.channelMember.findMany({ where: { channelId: { in: mine.map((m) => m.channelId) } }, select: { userId: true } })).map((m) => m.userId));
  return list.filter((p) => near.has(p.id) || p.id === me.userId);
}

/** Hands this page to the suite's frame, which opens it in a tab (/tab?u=…, query and hash kept). */
function ToSuite() {
  const go = `location.replace(${js(SUITE_PUBLIC_URL)}+"/tab?u="+encodeURIComponent(location.pathname+location.search+location.hash))`;
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: go }} />
      <noscript>
        <p className="ws-center">
          <a href={`${SUITE_PUBLIC_URL}/home`}>Open the suite</a>
        </p>
      </noscript>
    </>
  );
}

function GuestOnly() {
  return (
    <div className="ws-center">
      <h2 style={{ margin: "0 0 6px" }}>Guests can use Chat only</h2>
      <p>
        <a href="/workspace/chat">Open Chat</a>
      </p>
    </div>
  );
}

/** JSON for an inline script (no "</script>" breakouts). */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * A Calendar, Tasks or Chat page inside the suite shell. The account's theme
 * and accent are written for the before-paint script first, so the page never
 * flashes another theme (this origin may not have them stored yet).
 */
export function Frame({ shell, active, me, children }: { shell: SuiteShell; active: "calendar" | "tasks" | "teamchat" | "meetings"; me: Me; children: React.ReactNode }) {
  const paint = shell.offline
    ? ""
    : `try{localStorage.setItem("forge-theme",${js(shell.shell.appearance.theme)});localStorage.setItem("iotx-paint",${js(JSON.stringify(shell.paint))});window.__forgeApplyTheme&&window.__forgeApplyTheme();}catch(e){}`;
  return (
    <>
      {paint && <script dangerouslySetInnerHTML={{ __html: paint }} />}
      <SuiteFrame s={shell} active={active} chatOn={!!me.perms["teamchat.open"]}>
        {children}
      </SuiteFrame>
    </>
  );
}
