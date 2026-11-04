"use client";

export type Device = { id: string; label: string; w: number | null; h: number | null };

/**
 * Viewport presets for the preview frame. `null` width means "fill the pane",
 * which is the desktop case — a fixed desktop width would just add letterboxing.
 */
export const DEVICES: Device[] = [
  { id: "desktop", label: "Desktop", w: null, h: null },
  { id: "laptop", label: "Laptop", w: 1280, h: 800 },
  { id: "tablet", label: "Tablet", w: 834, h: 1112 },
  { id: "phone", label: "Phone", w: 390, h: 844 },
];

export default function DevicePicker({
  device,
  landscape,
  onDevice,
  onRotate,
}: {
  device: Device;
  landscape: boolean;
  onDevice: (d: Device) => void;
  onRotate: () => void;
}) {
  const rotatable = device.w !== null;

  return (
    <div className="flex items-center gap-1">
      <label className="sr-only" htmlFor="device-select">
        Preview device
      </label>
      <select
        id="device-select"
        value={device.id}
        onChange={(e) =>
          onDevice(DEVICES.find((d) => d.id === e.target.value) ?? DEVICES[0])
        }
        className="h-7 cursor-pointer rounded-lg bg-transparent px-1.5 text-[13px] outline-none hover:bg-black/[.05] dark:hover:bg-white/[.06]"
        style={{ color: "var(--muted)" }}
      >
        {DEVICES.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
            {d.w ? ` · ${d.w}` : ""}
          </option>
        ))}
      </select>

      {rotatable && (
        <button
          onClick={onRotate}
          aria-pressed={landscape}
          title={landscape ? "Switch to portrait" : "Switch to landscape"}
          className="h-7 rounded-lg px-2 text-[13px] transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06]"
          style={{ color: "var(--muted)" }}
        >
          {landscape ? "Landscape" : "Portrait"}
        </button>
      )}
    </div>
  );
}

/** Pixel size for the frame, accounting for rotation. */
export function frameSize(device: Device, landscape: boolean) {
  if (device.w === null || device.h === null) {
    return { width: "100%", height: "100%" };
  }
  return landscape
    ? { width: device.h, height: device.w }
    : { width: device.w, height: device.h };
}
