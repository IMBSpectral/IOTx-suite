// IOTx Read: on the call's page. Reads the meeting title and the names of
// the people in the call (where the platform shows them) and shows the
// "Recording for notes" badge while a recording runs. It never starts a
// recording by itself.
(() => {
  if (window.__iotxRead) return;
  window.__iotxRead = true;

  const host = location.hostname;
  const platform = host === "meet.google.com" ? "meet" : /(^|\.)zoom\.(us|com)$/.test(host) ? "zoom" : /teams\.(microsoft|live)\.com$/.test(host) ? "teams" : "other";
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const okName = (s) => s && s.length <= 60 && !/^(you|me|more options|mute|unmute|pin|presentation|\(you\))$/i.test(s) && !/\b(is presenting|presentation)\b/i.test(s);
  const texts = (sel, attr) => [...document.querySelectorAll(sel)].map((el) => clean(attr ? el.getAttribute(attr) : el.textContent));

  function scrapeMeet() {
    const t = document.querySelector("[data-meeting-title]")?.getAttribute("data-meeting-title") || clean(document.title).replace(/^Meet\s*[-–:]\s*/i, "");
    const names = [
      ...texts("[data-self-name]", "data-self-name"),
      ...texts("[data-participant-id] [data-self-name]", "data-self-name"),
      // Tiles and the People panel.
      ...[...document.querySelectorAll("[data-participant-id]")].map((el) => clean(el.querySelector("[jsname] span, span")?.textContent)),
      ...texts('[role="list"][aria-label] [role="listitem"]', "aria-label"),
    ];
    return { title: /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(t) ? "" : t, names };
  }
  function scrapeZoom() {
    const t = clean(document.querySelector(".meeting-info-container__header, .meeting-topic, [class*='meeting-title']")?.textContent) || "";
    const names = [...texts(".participants-item__display-name"), ...texts(".video-avatar__avatar-name"), ...texts(".video-avatar__avatar-footer span")];
    return { title: /^zoom( meeting)?$/i.test(t) ? "" : t, names };
  }
  function scrapeTeams() {
    const t = clean(document.querySelector('[data-tid="call-title"], [data-tid="meeting-title"]')?.textContent) || clean(document.title).replace(/\s*\|\s*Microsoft Teams.*$/i, "");
    const names = [...texts('[data-tid="roster-participant"] [title]', "title"), ...texts('[data-tid="participant-name"]'), ...texts('[data-cid="calling-participant-stream"]', "aria-label")];
    return { title: /^(microsoft teams|meeting|call)$/i.test(t) ? "" : t, names };
  }
  function scrapeOther() {
    return { title: clean(document.querySelector("[data-meeting-title]")?.getAttribute("data-meeting-title")) || clean(document.title), names: texts("[data-participant-name]", "data-participant-name") };
  }

  function scrape() {
    let r = { title: "", names: [] };
    try {
      r = platform === "meet" ? scrapeMeet() : platform === "zoom" ? scrapeZoom() : platform === "teams" ? scrapeTeams() : scrapeOther();
    } catch {}
    const participants = [...new Set(r.names.map((n) => clean(n).replace(/\s*\((you|host|guest)\)\s*$/i, "")).filter(okName))].slice(0, 100);
    return { platform, title: clean(r.title).slice(0, 200), participants, url: location.href };
  }

  // ── The badge (in a shadow root so the page's styles can't hide it) ──
  let badge = null;
  let timer = null;
  function showBadge(on) {
    if (!on) {
      badge?.remove();
      badge = null;
      clearInterval(timer);
      timer = null;
      return;
    }
    if (badge) return;
    badge = document.createElement("iotx-read-badge");
    const root = badge.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .b { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 10px;
             background: #1c1c22; color: #fff; font: 600 13px system-ui, sans-serif; padding: 7px 8px 7px 12px; border-radius: 999px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; animation: p 1.4s ease-in-out infinite; }
        @keyframes p { 50% { opacity: .35; } }
        button { all: unset; cursor: pointer; background: #e5484d; color: #fff; border-radius: 999px; padding: 3px 10px; font-size: 12px; }
        .min { background: transparent; color: #bbb; padding: 3px 6px; }
      </style>
      <div class="b" role="status" aria-live="polite"><span class="dot"></span><span>Recording for notes · IOTx Read</span><button class="stop">Stop</button><button class="min" title="Move">⇵</button></div>`;
    root.querySelector(".stop").addEventListener("click", () => chrome.runtime.sendMessage({ type: "page-stop" }));
    // Move it to the bottom if it covers the call's own controls (it can't be hidden).
    root.querySelector(".min").addEventListener("click", () => {
      const b = root.querySelector(".b");
      const bottom = b.style.top === "auto";
      b.style.top = bottom ? "10px" : "auto";
      b.style.bottom = bottom ? "auto" : "10px";
    });
    document.documentElement.appendChild(badge);
    // While recording: names seen on the page go to the meeting every 20 seconds.
    timer = setInterval(() => {
      const s = scrape();
      chrome.runtime.sendMessage({ type: "page-info", title: s.title, participants: s.participants }).catch(() => {});
    }, 20000);
  }

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m?.type === "ping") reply({ ok: true, platform });
    else if (m?.type === "scrape") reply(scrape());
    else if (m?.type === "badge") {
      showBadge(!!m.on);
      reply({ ok: true });
    }
    return false;
  });

  // After a reload during a recording, put the badge back.
  chrome.runtime.sendMessage({ type: "hello" }).then((r) => r?.recording && showBadge(true)).catch(() => {});
})();
