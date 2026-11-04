"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/BrandProvider";
import { useEscape } from "./useEscape";
import { Download, Smartphone, X } from "lucide-react";
import QRCode from "qrcode";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/**
 * "Get the app": install Forge as an app on this device (PWA), or scan a QR
 * code to open the page you're on with your phone, where you can turn on
 * notifications for when a build finishes.
 */
export default function GetTheApp() {
  const [open, setOpen] = useState(false);
  const brand = useBrand();
  useEscape(open ? () => setOpen(false) : null);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function show() {
    setOpen(true);
    const here = location.href;
    setUrl(here);
    setInstalled((v) => v || window.matchMedia("(display-mode: standalone)").matches);
    setQr(await QRCode.toDataURL(here, { margin: 1, width: 360, color: { dark: "#111111", light: "#ffffff" } }));
  }

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setPrompt(null);
  }

  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(url);
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

  return (
    <>
      <button
        onClick={() => void show()}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-black/[.05] dark:hover:bg-white/[.06]"
      >
        <Smartphone className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />
        <span className="truncate">Get the app</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label="Get the app"
            className="w-full max-w-sm rounded-2xl border p-5 shadow-2xl"
            style={{ background: "var(--panel)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Get the app</h2>
              <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 hover:bg-black/[.05] dark:hover:bg-white/[.06]">
                <X className="h-4 w-4" />
              </button>
            </div>

            <section className="mt-3">
              <h3 className="text-xs font-medium">On this device</h3>
              {installed ? (
                <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                  {brand.name} is installed. Open it from your apps or home screen.
                </p>
              ) : prompt ? (
                <button onClick={() => void install()} className="btn-primary mt-2 flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs">
                  <Download className="h-3.5 w-3.5" /> Install {brand.name}
                </button>
              ) : (
                <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                  {ios
                    ? "In Safari, tap Share, then Add to Home Screen."
                    : `Use your browser's menu: Install ${brand.name}, or Add to Home Screen.`}
                </p>
              )}
            </section>

            <section className="mt-4">
              <h3 className="text-xs font-medium">On your phone</h3>
              <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
                Scan to open this page on your phone, add it to your home screen, and turn on notifications to hear when
                {brand.shortName} finishes.
              </p>
              {qr && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="QR code for this page" className="mx-auto mt-3 h-44 w-44 rounded-lg border bg-white p-1" />
              )}
              {local && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  This address only works on this computer. Once {brand.name} is hosted, the code opens it anywhere.
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
