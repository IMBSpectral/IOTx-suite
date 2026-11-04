/**
 * Reads a write_file call's input as the model streams it (eager input
 * streaming sends the JSON in fragments), so the chat and the build view can
 * show the file's code while it is still being written, like Lovable.
 *
 * The input is `{"path": "...", "content": "..."}`. The path is taken once it
 * is complete; the content is decoded incrementally from where the last
 * fragment stopped, so the cost stays linear in the file's size. Nothing here
 * touches the filesystem: the real write still happens in the tool, after the
 * SDK validates the full input.
 */
export type LiveWrite = {
  raw: string;
  path: string | null;
  /** Index in `raw` where content decoding continues; -1 until "content" starts. */
  at: number;
  /** The content's closing quote was reached. */
  closed: boolean;
  text: string;
  /** How much of `text` has been sent. */
  sent: number;
  lastSent: number;
};

export function startLiveWrite(): LiveWrite {
  return { raw: "", path: null, at: -1, closed: false, text: "", sent: 0, lastSent: 0 };
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };

/** Feed one fragment of the tool input. */
export function feedLiveWrite(w: LiveWrite, fragment: string) {
  w.raw += fragment;
  if (w.path === null) {
    const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(w.raw);
    if (m) {
      try {
        w.path = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        w.path = m[1];
      }
    }
  }
  if (w.at < 0) {
    const m = /"content"\s*:\s*"/.exec(w.raw);
    if (!m) return;
    w.at = m.index + m[0].length;
  }
  if (w.closed) return;
  const raw = w.raw;
  let i = w.at;
  let out = "";
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      w.closed = true;
      break;
    }
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    // An escape split across fragments waits for the rest.
    if (i + 1 >= raw.length) break;
    const n = raw[i + 1];
    if (n === "u") {
      if (i + 6 > raw.length) break;
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16) || 0);
      i += 6;
    } else {
      out += ESCAPES[n] ?? n;
      i += 2;
    }
  }
  w.at = i;
  w.text += out;
}

/**
 * The next piece to send, or null when there is nothing new (or it is too
 * soon: fragments are coalesced to a few updates a second).
 */
export function takeLiveWrite(w: LiveWrite, force = false, now = Date.now()): { path: string; delta: string; start: boolean } | null {
  if (!w.path || w.sent >= w.text.length) return null;
  if (!force && now - w.lastSent < 250 && w.text.length - w.sent < 4000) return null;
  const delta = w.text.slice(w.sent);
  const start = w.sent === 0;
  w.sent = w.text.length;
  w.lastSent = now;
  return { path: w.path, delta, start };
}
