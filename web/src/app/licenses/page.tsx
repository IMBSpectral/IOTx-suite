import Link from "next/link";
import { getBrand } from "@/lib/brand";
import { BrandMark } from "@/components/BrandProvider";
import packages from "@/lib/licenses-data.json";
import "../legal.css";

export const metadata = { title: "Open-source licences" };

/** Components that ship inside the product but aren't npm dependencies of the apps. */
const BUNDLED = [
  { name: "Geist and Geist Mono (fonts)", license: "OFL-1.1", url: "https://github.com/vercel/geist-font" },
  { name: "Instrument Serif (font)", license: "OFL-1.1", url: "https://fonts.google.com/specimen/Instrument+Serif" },
  { name: "Lucide icons", license: "ISC", url: "https://lucide.dev" },
  { name: "LiveKit server (Meet video)", license: "Apache-2.0", url: "https://github.com/livekit/livekit" },
  { name: "MediaPipe (Meet background effects)", license: "Apache-2.0", url: "https://github.com/google-ai-edge/mediapipe" },
  { name: "RNNoise (Meet noise suppression)", license: "BSD-3-Clause", url: "https://github.com/xiph/rnnoise" },
  { name: "FFmpeg (Meet recordings)", license: "GPL-3.0-or-later (runs as a separate program on our servers)", url: "https://ffmpeg.org/legal.html" },
];

/** Public list of the open-source software the suite is built with, and their licences. */
export default function LicensesPage() {
  const b = getBrand();
  const list = packages as { name: string; version: string; license: string; url: string; apps: string[] }[];
  return (
    <main className="lgl">
      <div className="lgl-wrap">
        <Link href="/" className="lgl-top">
          <BrandMark size={28} /> {b.name}
        </Link>
        <h1>Open-source licences</h1>
        <p>
          {b.name} is built by {b.company} with the help of open-source software. We are grateful to its authors. Each component below is used under its own licence; the full licence text
          ships with each package and is available at the link.
        </p>

        <h2>Bundled components</h2>
        <ul>
          {BUNDLED.map((x) => (
            <li key={x.name}>
              <a href={x.url} rel="noopener noreferrer" target="_blank">
                {x.name}
              </a>{" "}
              · {x.license}
            </li>
          ))}
        </ul>

        <h2>Software packages</h2>
        <table className="lgl-table">
          <thead>
            <tr>
              <th>Package</th>
              <th>Version</th>
              <th>Licence</th>
              <th>Used in</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.name}>
                <td>
                  <a href={p.url} rel="noopener noreferrer" target="_blank">
                    {p.name}
                  </a>
                </td>
                <td>{p.version}</td>
                <td>{p.license}</td>
                <td>{p.apps.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Trademarks</h2>
        <p>
          Product names such as Google, Gmail, Google Drive, Claude, OpenAI, Zoom, Microsoft Teams, Slack, Notion and Stripe are trademarks of their owners and are mentioned only to describe
          integrations. {b.name} is not affiliated with or endorsed by them.
        </p>

        <footer>
          <span>© {new Date().getFullYear()} {b.company}</span>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/">Home</Link>
        </footer>
      </div>
    </main>
  );
}
