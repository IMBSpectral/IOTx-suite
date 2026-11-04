/**
 * Click-to-select, injected into the preview document.
 *
 * The preview runs on its own origin with no `allow-same-origin`, so the
 * editor cannot reach into it. This script is the deliberate, narrow channel:
 * it reports what the user clicked and nothing else, over postMessage.
 *
 * Kept as a string because it is executed by the preview, not by the app, and
 * must not be bundled into the editor.
 */
export const INSPECTOR_SCRIPT = `
(function () {
  var active = false;
  var hover = null;

  var box = document.createElement("div");
  box.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6d4aff;" +
    "background:rgba(109,74,255,.08);border-radius:3px;display:none;transition:all .05s";
  var tag = document.createElement("div");
  tag.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;background:#6d4aff;color:#fff;" +
    "font:500 11px ui-sans-serif,system-ui;padding:2px 6px;border-radius:4px;display:none";
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tag);

  function describe(el) {
    var parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push("#" + el.id);
    // classList avoids parsing the attribute, and avoids an escaped regex
    // having to survive being embedded in a template literal.
    var cls = Array.prototype.slice.call(el.classList || []);
    if (cls.length) parts.push("." + cls.slice(0, 3).join("."));
    return parts.join("");
  }

  // A short DOM path gives the model enough to locate the element in source
  // without shipping the whole tree.
  function pathOf(el) {
    var out = [];
    var node = el;
    for (var i = 0; node && node.nodeType === 1 && i < 5; i++) {
      out.unshift(describe(node));
      node = node.parentElement;
    }
    return out.join(" > ");
  }

  // A precise CSS path (tag:nth-of-type from body) that finds the same
  // element again later, for comment pins.
  function locatorOf(el) {
    var out = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var i = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) i++;
        sib = sib.previousElementSibling;
      }
      out.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return "body > " + out.join(" > ");
  }

  // Comment pins: numbered badges at the top-right of their elements,
  // re-placed as the page scrolls or changes. Pins whose element is gone are
  // reported back as orphans.
  var pins = [];
  var pinLayer = document.createElement("div");
  pinLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  document.documentElement.appendChild(pinLayer);
  var lastMissing = "";
  function placePins() {
    pinLayer.innerHTML = "";
    var missing = [];
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i];
      var el = null;
      try { el = document.querySelector(p.locator); } catch (err) { el = null; }
      if (!el) { missing.push(p.id); continue; }
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { missing.push(p.id); continue; }
      var b = document.createElement("button");
      b.textContent = String(p.n);
      b.setAttribute("aria-label", "Comment " + p.n);
      b.style.cssText =
        "position:fixed;pointer-events:auto;width:22px;height:22px;border-radius:11px 11px 11px 2px;border:2px solid #fff;" +
        "font:600 11px ui-sans-serif,system-ui;color:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);" +
        "background:" + (p.active ? "#1c1917" : "#6d4aff") + ";left:" + Math.min(window.innerWidth - 24, r.right - 8) +
        "px;top:" + Math.max(2, r.top - 12) + "px";
      (function (id) {
        b.addEventListener("click", function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          parent.postMessage({ source: "forge-preview", type: "pin-click", id: id }, "*");
        });
      })(p.id);
      pinLayer.appendChild(b);
    }
    var key = missing.join(",");
    if (key !== lastMissing) {
      lastMissing = key;
      parent.postMessage({ source: "forge-preview", type: "pins-missing", ids: missing }, "*");
    }
  }
  setInterval(function () { if (pins.length) placePins(); }, 700);
  window.addEventListener("scroll", function () { if (pins.length) placePins(); }, true);
  window.addEventListener("resize", function () { if (pins.length) placePins(); });

  // Inline text editing: click a text-only element to type over it. The old
  // and new text go back to the editor as a pending change on blur.
  var textEditing = false;
  function textOnly(el) {
    if (!el || el.nodeType !== 1 || !el.childNodes.length) return false;
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 1 && n.tagName !== "BR") return false;
    }
    return (el.textContent || "").trim().length > 0;
  }
  document.addEventListener(
    "click",
    function (e) {
      if (!textEditing) return;
      var el = e.target;
      e.preventDefault();
      e.stopPropagation();
      if (!textOnly(el) || el.isContentEditable) return;
      var before = el.textContent;
      el.contentEditable = "true";
      el.style.outline = "2px dashed #6d4aff";
      el.style.outlineOffset = "2px";
      el.focus();
      el.addEventListener(
        "blur",
        function () {
          el.contentEditable = "false";
          el.style.outline = "";
          var after = el.textContent;
          if (after !== before) {
            parent.postMessage(
              { source: "forge-preview", type: "text-change", oldText: before, newText: after, selector: describe(el) },
              "*"
            );
          }
        },
        { once: true }
      );
    },
    true
  );

  function paint(el) {
    var r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    tag.style.display = "block";
    tag.style.left = r.left + "px";
    tag.style.top = Math.max(0, r.top - 20) + "px";
    tag.textContent = describe(el);
  }

  function clear() {
    box.style.display = "none";
    tag.style.display = "none";
    hover = null;
  }

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.source !== "forge-editor") return;
    if (e.data.type === "pins") {
      pins = e.data.pins || [];
      lastMissing = "";
      placePins();
      return;
    }
    if (e.data.type === "textedit") {
      textEditing = !!e.data.enabled;
      document.body.style.cursor = textEditing ? "text" : "";
      return;
    }
    if (e.data.type === "inspect") {
      active = !!e.data.enabled;
      if (!active) clear();
      document.body.style.cursor = active ? "crosshair" : "";
    }
  });

  document.addEventListener(
    "mousemove",
    function (e) {
      if (!active) return;
      var el = e.target;
      if (!el || el.nodeType !== 1 || el === hover) return;
      hover = el;
      paint(el);
    },
    true
  );

  document.addEventListener(
    "click",
    function (e) {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      var el = e.target;
      if (!el || el.nodeType !== 1) return;
      var r = el.getBoundingClientRect();
      parent.postMessage(
        {
          source: "forge-preview",
          type: "selected",
          selector: describe(el),
          path: pathOf(el),
          locator: locatorOf(el),
          text: (el.textContent || "").trim().slice(0, 120),
          rect: { w: Math.round(r.width), h: Math.round(r.height) }
        },
        "*"
      );
      active = false;
      clear();
      document.body.style.cursor = "";
      // Comments keep a picture of the element as it was ("Element at annotation time").
      setTimeout(function () { snapshot(el, locatorOf(el)); }, 0);
    },
    true
  );

  // Copies computed styles onto the clone so it renders on its own, and
  // inlines same-origin images (an SVG image can't load external ones).
  function inlineStyles(src, dst) {
    var cs = getComputedStyle(src);
    var css = "";
    for (var i = 0; i < cs.length; i++) css += cs[i] + ":" + cs.getPropertyValue(cs[i]) + ";";
    dst.setAttribute("style", css);
    if (src.tagName === "IMG") {
      dst.removeAttribute("srcset");
      try {
        if (src.complete && src.naturalWidth) {
          var ic = document.createElement("canvas");
          ic.width = src.naturalWidth;
          ic.height = src.naturalHeight;
          ic.getContext("2d").drawImage(src, 0, 0);
          dst.setAttribute("src", ic.toDataURL("image/png"));
        }
      } catch (err) {}
    }
    var a = src.children, b = dst.children;
    for (var j = 0; j < a.length && j < b.length; j++) inlineStyles(a[j], b[j]);
  }

  function backgroundOf(el) {
    for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      var bg = getComputedStyle(cur).backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    }
    return "#ffffff";
  }

  // Best effort: very large elements, or a browser that refuses, give no picture.
  function snapshot(el, locator) {
    try {
      var r = el.getBoundingClientRect();
      var w = Math.ceil(r.width), h = Math.ceil(r.height);
      if (w < 2 || h < 2 || w > 2400 || h > 2400 || el.getElementsByTagName("*").length > 1500) return;
      var clone = el.cloneNode(true);
      inlineStyles(el, clone);
      clone.style.margin = "0";
      var xml = new XMLSerializer().serializeToString(clone);
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<foreignObject width="100%" height="100%">' + xml + "</foreignObject></svg>";
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, 640 / w, 480 / h);
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          var ctx = c.getContext("2d");
          ctx.fillStyle = backgroundOf(el);
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          parent.postMessage({ source: "forge-preview", type: "element-shot", locator: locator, image: c.toDataURL("image/jpeg", 0.85) }, "*");
        } catch (err) {}
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (err) {}
  }

  document.addEventListener("mouseleave", clear);
})();
`;
