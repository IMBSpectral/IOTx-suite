/** Shown inside the suite shell when the person's role doesn't open this app. */
export default function NoAccess({ name }: { name: string }) {
  return (
    <div className="ws-empty">
      <h2 style={{ color: "var(--ix-ink)", margin: "0 0 6px" }}>{name} isn&apos;t turned on for you</h2>
      <p>Ask an admin to switch on {name} for your role in Settings → Roles.</p>
    </div>
  );
}
