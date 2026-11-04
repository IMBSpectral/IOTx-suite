// IOTx Read: the offscreen document. It holds the tab-capture stream and the
// microphone, records with recorder.js and uploads each 10-second chunk.
let current = null;

const stopAll = (...streams) => streams.forEach((s) => s?.getTracks().forEach((t) => t.stop()));

async function start(m) {
  if (current) throw new Error("Already recording.");
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: m.streamId } },
      video: false,
    });
  } catch (e) {
    throw new Error(`Couldn't capture the tab's sound (${e?.name || "error"}: ${e?.message || e}).`);
  }
  let micStream = null;
  let micError = "";
  if (m.mic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      // Not allowed yet: the popup offers "Allow microphone" (mic.html). The call is still recorded.
      micError = e?.name === "NotAllowedError" ? "Microphone not allowed" : `Microphone unavailable (${e?.message || e?.name || e})`;
    }
  }
  const up = new IotxRecorder.Uploader({
    server: m.server,
    token: m.token,
    captureId: m.captureId,
    onProgress: (u) => chrome.runtime.sendMessage({ type: "progress", uploaded: u.uploaded, failed: u.failed }).catch(() => {}),
  });
  let rec;
  try {
    rec = await IotxRecorder.mixAndRecord(tabStream, micStream, { onChunk: (seq, blob) => up.add(seq, blob) });
  } catch (e) {
    stopAll(tabStream, micStream);
    throw new Error(`The recorder couldn't start (${e?.name || "error"}: ${e?.message || e}).`);
  }
  current = { rec, up, discard: false };
  // The call's tab closed or navigated away: finish (the service worker sends "stop").
  tabStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (current) chrome.runtime.sendMessage({ type: "tab-ended" }).catch(() => {});
  });
  return { ok: true, mic: !!micStream, micError, mime: rec.mime };
}

async function stop(m) {
  if (!current) return { ok: false, error: "Not recording." };
  const c = current;
  current = null;
  const chunks = await c.rec.stop();
  if (!m.discard) await c.up.drain();
  return { ok: c.up.failed === 0, chunks, uploaded: c.up.uploaded, failed: c.up.failed, bytes: c.up.bytes };
}

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.target !== "offscreen") return false;
  const fn = m.type === "start" ? start : m.type === "stop" ? stop : null;
  if (!fn) return false;
  fn(m).then(reply, (e) => reply({ ok: false, error: e?.message || String(e) }));
  return true;
});
