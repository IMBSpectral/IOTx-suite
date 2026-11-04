// The offscreen recorder can't ask for the microphone itself, so this page
// asks once; Chrome then remembers it for the extension.
document.getElementById("allow").onclick = async () => {
  const out = document.getElementById("out");
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.textContent = "Done. You can close this tab.";
    chrome.storage.local.set({ mic: true });
  } catch (e) {
    out.textContent = e?.name === "NotAllowedError" ? "Chrome blocked the microphone. Click the icon in the address bar to allow it, then try again." : `The microphone isn't available: ${e?.message || e}`;
  }
};
