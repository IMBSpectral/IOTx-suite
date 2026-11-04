"use client";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

/**
 * "Strong (AI)" noise suppression: RNNoise (a small recurrent neural network,
 * BSD) compiled to WASM, running in an AudioWorklet on this device. From
 * @sapphi-red/web-noise-suppressor 0.4.1 (MIT); the worklet and the WASM files
 * are served from this app (/workspace/meet-noise), not a CDN. Nothing leaves
 * the browser. RNNoise works at 48 kHz, so the processor runs its own 48 kHz
 * audio context.
 */

const BASE = "/workspace/meet-noise";
let wasm: Promise<ArrayBuffer> | null = null;

export const aiNoiseSupported = () => typeof window !== "undefined" && typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined";

export function rnnoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let ctx: AudioContext | null = null;
  let node: (AudioWorkletNode & { destroy?: () => void }) | null = null;
  let src: MediaStreamAudioSourceNode | null = null;

  const teardown = async () => {
    try {
      src?.disconnect();
      node?.disconnect();
      node?.destroy?.();
    } catch {}
    await ctx?.close().catch(() => {});
    ctx = null;
    node = null;
    src = null;
  };

  const p: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "iotx-rnnoise",
    async init(opts) {
      const lib = await import("@sapphi-red/web-noise-suppressor");
      wasm ??= lib.loadRnnoise({ url: `${BASE}/rnnoise.wasm`, simdUrl: `${BASE}/rnnoise_simd.wasm` });
      const binary = await wasm;
      try {
        ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.audioWorklet.addModule(`${BASE}/rnnoiseWorklet.js`);
        src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      } catch {
        // Some browsers can't resample a microphone into a 48 kHz context: use the device's rate.
        await ctx?.close().catch(() => {});
        ctx = new AudioContext();
        await ctx.audioWorklet.addModule(`${BASE}/rnnoiseWorklet.js`);
        src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
      }
      node = new lib.RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
      const dest = ctx.createMediaStreamDestination();
      src.connect(node).connect(dest);
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      p.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      await teardown();
      await p.init(opts);
    },
    async destroy() {
      await teardown();
      p.processedTrack = undefined;
    },
  };
  return p;
}
