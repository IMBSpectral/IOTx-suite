// Build the IOTx Read extension: draws the toolbar icons (PNG, no
// dependencies) and packs the extension into dist/read-extension.zip, also
// copied to apps/workspace/public so Meet → Integrations can offer it.
//   node scripts/build.mjs            icons (if missing) + zip
//   node scripts/build.mjs --icons    redraw the icons
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const FILES = ["manifest.json", "background.js", "offscreen.html", "offscreen.js", "recorder.js", "content.js", "popup.html", "popup.css", "popup.js", "mic.html", "mic.js", "README.md", "icons/icon.svg", "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"];

// ── CRC-32 (PNG and ZIP) ──
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// ── Icons: an indigo rounded square with a white ring and a red "recording" dot ──
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 128;
  const cover = (d) => Math.max(0, Math.min(1, 0.5 - d / s)); // anti-aliased coverage from a signed distance
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) / s, fy = (y + 0.5) / s;
      const qx = Math.max(Math.abs(fx - 64) - 40, 0), qy = Math.max(Math.abs(fy - 64) - 40, 0);
      const box = Math.hypot(qx, qy) - 20; // rounded square, radius 20, 120 wide
      const r = Math.hypot(fx - 64, fy - 64);
      const ring = Math.abs(r - 34) - 7;
      const dot = r - 18;
      let [R, G, B, A] = [0, 0, 0, 0];
      const a = cover(box * s);
      if (a > 0) {
        const t = (fx + fy) / 256; // indigo to violet
        [R, G, B, A] = [79 + (124 - 79) * t, 70 + (58 - 70) * t, 229 + (237 - 229) * t, a];
        const w = cover(ring * s);
        [R, G, B] = [R + (255 - R) * w, G + (255 - G) * w, B + (255 - B) * w];
        const d = cover(dot * s);
        [R, G, B] = [R + (229 - R) * d, G + (72 - G) * d, B + (77 - B) * d];
      }
      const i = (y * size + x) * 4;
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.round(A * 255);
    }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="20" fill="url(#g)"/><circle cx="64" cy="64" r="34" fill="none" stroke="#fff" stroke-width="14"/><circle cx="64" cy="64" r="18" fill="#e5484d"/></svg>\n`;

function icons(force) {
  const dir = path.join(ROOT, "icons");
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [16, 32, 48, 128]) {
    const f = path.join(dir, `icon${n}.png`);
    if (force || !fs.existsSync(f)) fs.writeFileSync(f, png(n));
  }
  const svg = path.join(dir, "icon.svg");
  if (force || !fs.existsSync(svg)) fs.writeFileSync(svg, SVG);
}

// ── ZIP (deflate) ──
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const dos = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
  const { time, date } = dos(new Date());
  for (const { name, data } of entries) {
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const force = process.argv.includes("--icons");
icons(force);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const entries = FILES.map((f) => ({ name: `read-extension/${f}`, data: fs.readFileSync(path.join(ROOT, f)) }));
const out = zip(entries);
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "dist", "read-extension.zip"), out);
const pub = path.resolve(ROOT, "..", "workspace", "public", "read-extension.zip");
fs.writeFileSync(pub, out);
console.log(`IOTx Read ${manifest.version}: ${entries.length} files, ${(out.length / 1024).toFixed(1)} KB -> dist/read-extension.zip and ${path.relative(path.resolve(ROOT, ".."), pub)}`);
