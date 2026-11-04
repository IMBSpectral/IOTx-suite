/**
 * Comment widget for preview links that allow guest comments. Served from
 * the link's own host as /__forge/comments.js and posts back to
 * /__forge/comments on that host, so it carries the link's unlock cookie and
 * nothing else. Kept as a string: it runs in the guest's page, not the editor.
 */
export const GUEST_COMMENT_SCRIPT = `
(function () {
  var picking = false;
  var NAME_KEY = "forge:guest-name";
  var ui = document.createElement("div");
  ui.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px ui-sans-serif,system-ui";
  var btn = document.createElement("button");
  btn.textContent = "Comment";
  btn.style.cssText = "background:#6d4aff;color:#fff;border:0;border-radius:999px;padding:9px 16px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)";
  ui.appendChild(btn);
  document.documentElement.appendChild(ui);

  var box = document.createElement("div");
  box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #6d4aff;background:rgba(109,74,255,.08);border-radius:3px;display:none";
  document.documentElement.appendChild(box);

  function describe(el) {
    var parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push("#" + el.id);
    var cls = Array.prototype.slice.call(el.classList || []);
    if (cls.length) parts.push("." + cls.slice(0, 3).join("."));
    return parts.join("");
  }
  function locatorOf(el) {
    var out = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var i = 1;
      var sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
      out.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return "body > " + out.join(" > ");
  }
  function inUi(el) { return ui.contains(el); }

  btn.addEventListener("click", function () {
    picking = !picking;
    btn.textContent = picking ? "Click an element…" : "Comment";
    document.body.style.cursor = picking ? "crosshair" : "";
    if (!picking) box.style.display = "none";
  });

  document.addEventListener("mousemove", function (e) {
    if (!picking || inUi(e.target)) return;
    var r = e.target.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
  }, true);

  document.addEventListener("click", function (e) {
    if (!picking || inUi(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    picking = false;
    btn.textContent = "Comment";
    document.body.style.cursor = "";
    box.style.display = "none";
    openForm(e.target);
  }, true);

  function openForm(el) {
    var form = document.createElement("form");
    form.style.cssText = "position:fixed;right:16px;bottom:64px;width:280px;background:#fff;color:#1c1917;border:1px solid #e7e5e4;border-radius:14px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);z-index:2147483647;font:13px ui-sans-serif,system-ui";
    var saved = "";
    try { saved = localStorage.getItem(NAME_KEY) || ""; } catch (err) {}
    form.innerHTML =
      '<p style="margin:0 0 8px;font-weight:600">Leave a comment</p>' +
      '<input name="name" required maxlength="60" placeholder="Your name" aria-label="Your name" style="width:100%;box-sizing:border-box;margin-bottom:6px;padding:7px 9px;border:1px solid #d6d3d1;border-radius:8px">' +
      '<textarea name="body" required maxlength="2000" rows="3" placeholder="What should change?" aria-label="Comment" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d6d3d1;border-radius:8px;resize:none"></textarea>' +
      '<p class="msg" role="status" style="margin:6px 0 0;font-size:12px;color:#78716c"></p>' +
      '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px"><button type="button" class="cancel" style="border:0;background:none;color:#78716c;cursor:pointer">Cancel</button>' +
      '<button style="background:#1c1917;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer">Send</button></div>';
    form.elements.name.value = saved;
    ui.appendChild(form);
    (saved ? form.elements.body : form.elements.name).focus();
    form.querySelector(".cancel").addEventListener("click", function () { form.remove(); });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = form.elements.name.value.trim();
      try { localStorage.setItem(NAME_KEY, name); } catch (err) {}
      fetch("/__forge/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name,
          body: form.elements.body.value,
          locator: locatorOf(el),
          selector: describe(el),
          text: (el.textContent || "").trim().slice(0, 120)
        })
      }).then(function (r) {
        var msg = form.querySelector(".msg");
        if (r.ok) { msg.textContent = "Thanks, your comment was sent."; setTimeout(function () { form.remove(); }, 1500); }
        else { msg.textContent = "Couldn't send the comment."; msg.style.color = "#dc2626"; }
      });
    });
  }
})();
`;
