// IOTx Read: the recording logic, kept apart from the extension APIs so it
// can be tested in a plain page. Mixes the call's audio (the tab) with the
// person's microphone, keeps the call audible, records Opus in WebM and
// hands a chunk every 10 seconds to an uploader that sends them in order,
// retrying with backoff.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Sends chunks in order: PUT <base>/meet/ext/capture/<id>/chunk?seq=N. */
  class Uploader {
    constructor({ server, token, captureId, onProgress, fetchImpl }) {
      this.url = `${server}/workspace/api/meet/ext/capture/${captureId}/chunk`;
      this.token = token;
      this.onProgress = onProgress || (() => {});
      this.fetch = fetchImpl || ((...a) => fetch(...a));
      this.queue = Promise.resolve();
      this.uploaded = 0;
      this.failed = 0;
      this.bytes = 0;
    }
    add(seq, blob) {
      this.queue = this.queue.then(() => this.send(seq, blob));
      return this.queue;
    }
    async send(seq, blob) {
      for (let i = 0; i < 6; i++) {
        try {
          const r = await this.fetch(`${this.url}?seq=${seq}`, { method: "PUT", headers: { authorization: `Bearer ${this.token}`, "content-type": blob.type || "audio/webm" }, body: blob });
          if (r.ok) {
            this.uploaded++;
            this.bytes += blob.size;
            this.onProgress(this);
            return;
          }
          // Revoked token, a recording that was thrown away or finished: retrying won't help.
          if ([400, 401, 403, 404, 409, 413].includes(r.status)) break;
        } catch {}
        await sleep(Math.min(16000, 500 * 2 ** i));
      }
      this.failed++;
      this.onProgress(this);
    }
    drain() {
      return this.queue;
    }
  }

  /**
   * Record tab + mic. Returns { recorder, stop(), mime }.
   * tabStream: the call (required). micStream: optional.
   */
  function mixAndRecord(tabStream, micStream, { timeslice = 10000, onChunk, playback = true, bitsPerSecond = 32000 } = {}) {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const tab = ctx.createMediaStreamSource(tabStream);
    tab.connect(dest);
    // Capturing a tab mutes it for the person; play it back so they still hear the call.
    if (playback) tab.connect(ctx.destination);
    if (micStream) ctx.createMediaStreamSource(micStream).connect(dest);
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: bitsPerSecond });
    let seq = 0;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) onChunk(seq++, e.data);
    };
    recorder.start(timeslice);
    const stop = async () => {
      if (recorder.state !== "inactive") {
        const done = new Promise((r) => recorder.addEventListener("stop", r, { once: true }));
        recorder.stop(); // the last dataavailable comes before "stop"
        await done;
      }
      for (const s of [tabStream, micStream]) s?.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
      return seq;
    };
    return { recorder, stop, mime, chunks: () => seq };
  }

  globalThis.IotxRecorder = { Uploader, mixAndRecord };
})();
