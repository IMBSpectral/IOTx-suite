/**
 * Runtime monitor, injected into the preview next to the click-to-select
 * bridge.
 *
 * The build check proves an app compiles; it cannot see an app that compiles
 * and then throws on load, renders blank, or calls an endpoint that 404s.
 * This captures exactly those — uncaught errors, unhandled rejections,
 * console errors and warnings, failed resource loads and failed fetches — and
 * hands them to the editor over postMessage. Lovable's agent reads the same
 * three streams (runtime errors, console logs, network requests).
 *
 * Kept as a string because it runs inside the preview, not the editor. It must
 * stay ES5 with no backticks, dollar-brace sequences or regex escapes, because
 * it is embedded in a template literal.
 */
export const MONITOR_SCRIPT = `
(function () {
  if (window.__forgeMonitor) return;
  window.__forgeMonitor = true;

  var sent = 0;
  var NOISE = ["React Router Future Flag Warning", "Download the React DevTools", "[vite] connected", "[vite] connecting"];

  function noisy(message) {
    for (var i = 0; i < NOISE.length; i++) {
      if (message.indexOf(NOISE[i]) !== -1) return true;
    }
    return false;
  }

  function post(entry) {
    if (sent >= 200 || noisy(entry.message || "")) return;
    sent++;
    entry.source = "forge-preview";
    entry.type = "log";
    entry.at = Date.now();
    entry.url = location.pathname;
    try { parent.postMessage(entry, "*"); } catch (e) {}
  }

  function text(v) {
    try {
      if (v instanceof Error) return v.name + ": " + v.message;
      if (typeof v === "string") return v;
      return JSON.stringify(v);
    } catch (e) {
      return String(v);
    }
  }

  function join(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(text(list[i]));
    return out.join(" ").slice(0, 2000);
  }

  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      post({ level: "error", kind: "resource", message: "Failed to load " + (t.src || t.href || t.tagName) });
      return;
    }
    post({
      level: "error",
      kind: "runtime",
      message: e.message || "Script error",
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 4000) : "",
      file: e.filename || "",
      line: e.lineno || 0
    });
  }, true);

  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    post({
      level: "error",
      kind: "runtime",
      message: "Unhandled promise rejection: " + text(r),
      stack: r && r.stack ? String(r.stack).slice(0, 4000) : ""
    });
  });

  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try { post({ level: level, kind: "console", message: join(arguments) }); } catch (e) {}
      return original.apply(console, arguments);
    };
  });

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || "GET";
      return originalFetch.apply(this, arguments).then(function (res) {
        if (!res.ok) post({ level: "warn", kind: "network", message: method + " " + url + " -> HTTP " + res.status });
        return res;
      }, function (err) {
        post({ level: "error", kind: "network", message: method + " " + url + " failed: " + text(err) });
        throw err;
      });
    };
  }
})();
`;
