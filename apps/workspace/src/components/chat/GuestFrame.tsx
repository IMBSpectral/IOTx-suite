"use client";
import { LogOut, MessagesSquare } from "lucide-react";

/** Chat for a guest: no suite sidebar or launcher, just who they are and a way out. */
export default function GuestFrame({ name, email, children }: { name: string; email: string; children: React.ReactNode }) {
  const signOut = () => {
    fetch("/workspace/api/auth/session", { method: "DELETE" }).finally(() => window.location.replace("/workspace/chat/guest?signedout=1"));
  };
  return (
    <div className="gf-root">
      <header className="gf-top">
        <span className="gf-mark"><MessagesSquare size={16} /></span>
        <b>Chat</b>
        <span className="ch-guest">Guest</span>
        <span className="ix-sp" />
        <span className="gf-who ws-hide-mobile">
          {name}
          <small>{email}</small>
        </span>
        <button type="button" className="ix-iconbtn" onClick={signOut} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>
      </header>
      <div className="gf-body">{children}</div>
    </div>
  );
}
