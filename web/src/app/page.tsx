import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getBrand, type Brand } from "@/lib/brand";
import { BrandMark } from "@/components/BrandProvider";
import { Icon, NineDots } from "@/components/iotx/icons";
import { ORBIT_INNER, ORBIT_OUTER } from "@/components/iotx/Orbit";
import "./landing.css";

// Signed-in people go straight to their IOTx home; everyone else sees the suite.
export const dynamic = "force-dynamic";

const APPS = [...ORBIT_INNER, ...ORBIT_OUTER];

const statement = (b: Brand) =>
  `Describe what your business needs. ${b.name} builds it, hosts it on your domain, and gives exactly the right people access. Accounts, sheets, documents and your own apps, under one sign-in.`;

const VOUCHERS = [
  ["Sales", "Ashvan Steelworks", "₹1,84,500", "GST 18%"],
  ["Purchase", "Neelgiri Coils", "₹96,200", "GST 18%"],
  ["Receipt", "Kestrel Arcworks", "₹2,40,000", "Bank"],
  ["Payment", "Freight & Logistics", "₹18,750", "Cash"],
  ["Journal", "Depreciation", "₹42,000", "Year end"],
  ["Sales", "Tarang Fabrication", "₹73,900", "GST 12%"],
];

const SWITCHES: [string, boolean][] = [
  ["Builder", true],
  ["Publish apps", true],
  ["SQL editor", false],
  ["Delete sales vouchers", false],
  ["Export sheets", true],
];

function AppDot({ app, size = 34 }: { app: (typeof APPS)[number]; size?: number }) {
  return (
    <span className="x-dot" style={{ background: app.color, width: size, height: size }} title={app.name}>
      <Icon name={app.icon} size={Math.round(size * 0.48)} />
    </span>
  );
}

/** A faithful, static rendering of the IOTx Suite home: the product shot. */
function ProductShot({ brand }: { brand: Brand }) {
  return (
    <div className="x-shot" aria-hidden="true">
      <div className="x-frame">
        <aside className="x-side">
          <div className="x-side-brand"><BrandMark size={24} radius={7} /> {brand.name}</div>
          <div className="x-newchat"><Icon name="add" size={13} /> New chat</div>
          <div className="x-nav on"><Icon name="home" size={14} /> Home</div>
          <div className="x-nav"><Icon name="admin" size={14} /> Roles &amp; permissions</div>
          <div className="x-side-h">Recent</div>
          {["Inventory system", "Production dashboard", "Client portal", "HR approvals"].map((r) => (
            <div key={r} className="x-nav dim"><Icon name="chatline" size={13} /> {r}</div>
          ))}
          <div className="x-side-h">Shared</div>
          {APPS.slice(0, 4).map((a) => (
            <div key={a.name} className="x-nav"><AppDot app={a} size={18} /> {a.name}</div>
          ))}
        </aside>
        <div className="x-main">
          <div className="x-top">
            <div className="x-search"><Icon name="search" size={13} /> Search or ask {brand.shortName}…<kbd>Ctrl K</kbd></div>
            <span className="x-grow" />
            <span className="x-icon on"><NineDots size={14} /></span>
            <span className="x-icon"><Icon name="sun" size={14} /></span>
            <span className="x-avatar">K</span>
          </div>
          <div className="x-home">
            <div className="x-greet">Good morning</div>
            <div className="x-h">What would you like to <em>build</em> today?</div>
            <div className="x-prompt">
              <span className="x-typed">Build an inventory system for two yards, with PO approvals over ₹2 lakh</span>
              <div className="x-prompt-bar">
                <span className="x-chip">Chat</span>
                <span className="x-chip">Plan</span>
                <span className="x-chip on">Build</span>
                <span className="x-send"><Icon name="send" size={13} /></span>
              </div>
            </div>
            <div className="x-apps">
              {APPS.slice(0, 7).map((a) => (
                <div key={a.name} className="x-app"><AppDot app={a} size={30} /><span>{a.name}</span></div>
              ))}
            </div>
          </div>
          <div className="x-launcher">
            <div className="x-launcher-h">{brand.shortName} Apps</div>
            <div className="x-launcher-grid">
              {APPS.map((a) => (
                <div key={a.name}><AppDot app={a} size={28} /><span>{a.name}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function Landing() {
  const session = await auth();
  if (session?.user) redirect("/home");
  const brand = getBrand();

  return (
    <div className="x">
      <header className="x-navbar">
        <Link href="/" className="lg-brand x-brand">
          <BrandMark size={24} radius={7} />
          {brand.name}
        </Link>
        <nav aria-label="Sections">
          <a href="#suite">Suite</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#security">Security</a>
        </nav>
        <div className="x-navbar-cta">
          <Link href="/login" className="x-quiet">Sign in</Link>
          <Link href="/login" className="x-btn x-btn-sm">Get started</Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="x-hero">
        <div className="x-beam" aria-hidden="true" />
        <div className="x-stars" aria-hidden="true" />
        <Link href="/login" className="x-pill">
          <span className="x-pill-dot" /> The AI Builder is live
          <Icon name="send" size={12} />
        </Link>
        <h1>
          Run your entire business
          <br />
          <em>from one place.</em>
        </h1>
        <p className="x-lead">
          The operating suite for growing companies: accounts, data, documents, tasks, and an AI that builds the apps only you need.
        </p>
        <div className="x-ctas">
          <Link href="/login" className="x-btn">Start building <Icon name="send" size={15} /></Link>
          <a href="#suite" className="x-btn x-btn-ghost">Explore the suite</a>
        </div>
        <div className="x-shot-wrap">
          <div className="x-shot-glow" aria-hidden="true" />
          <ProductShot brand={brand} />
        </div>
      </section>

      {/* ── App marquee ── */}
      <section id="suite" className="x-marquee" aria-label={`Apps in ${brand.name}`}>
        <div className="x-marquee-track">
          {[...APPS, ...APPS].map((a, i) => (
            <span key={i} className="x-marquee-item" aria-hidden={i >= APPS.length}>
              <AppDot app={a} size={30} /> {a.name}
            </span>
          ))}
        </div>
      </section>

      {/* ── Statement that lights up as you scroll ── */}
      <section className="x-statement">
        <p>
          {statement(brand).split(" ").map((w, i) => (
            <span key={i}>{w} </span>
          ))}
        </p>
      </section>

      {/* ── Capabilities mosaic ── */}
      <section id="capabilities" className="x-section">
        <p className="x-kicker">Capabilities</p>
        <h2>One suite. <em>Every moving part.</em></h2>

        <div className="x-bento">
          <article className="x-tile x-tile-builder">
            <div className="x-tile-copy">
              <span className="x-tag">AI Builder</span>
              <h3>Say it. Ship it.</h3>
              <p>Describe the app in plain words. {brand.shortName} plans it, builds it with a database, and publishes it to your domain.</p>
            </div>
            <div className="x-term">
              <div className="x-term-line me">Inventory for two yards, PO approval over ₹2 lakh</div>
              {["Planning screens and tables", "Building materials catalogue", "Adding approval workflow", "Running checks"].map((s, i) => (
                <div key={s} className="x-term-line step" style={{ ["--d" as string]: `${i * 0.7}s` }}>
                  <Icon name="tasks" size={13} /> {s}
                </div>
              ))}
              <div className="x-term-line live" style={{ ["--d" as string]: "2.9s" }}>
                <span className="x-live-dot" /> Live at <b>inventory.yourcompany.com</b>
              </div>
            </div>
          </article>

          <article className="x-tile x-tile-perm">
            <span className="x-tag">Permissions</span>
            <h3>A switch for every feature.</h3>
            <div className="x-switches">
              {SWITCHES.map(([name, on], i) => (
                <div key={name} className="x-switch-row">
                  <span>{name}</span>
                  <span className={`x-switch ${on ? "on" : ""} ${i === 2 ? "flip" : ""}`}><i /></span>
                </div>
              ))}
            </div>
          </article>

          <article className="x-tile x-tile-tally">
            <span className="x-tag">Accounts</span>
            <h3>Books that balance themselves.</h3>
            <div className="x-ledger">
              <div className="x-ledger-track">
                {[...VOUCHERS, ...VOUCHERS].map(([type, party, amt, tag], i) => (
                  <div key={i} className="x-ledger-row">
                    <span className={`x-vt x-vt-${type.toLowerCase()}`}>{type}</span>
                    <span className="x-party">{party}</span>
                    <span className="x-amt">{amt}</span>
                    <span className="x-gst">{tag}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>

          <article className="x-tile x-tile-sheets">
            <span className="x-tag">Sheets</span>
            <h3>Data that keeps up.</h3>
            <div className="x-grid" aria-hidden="true">
              <div className="x-formula"><b>fx</b> =SUM(C2:C7)</div>
              <div className="x-cells">
                {[
                  ["Item", "Yard", "Qty", "Value"],
                  ["HR coil 2mm", "Pune", "48", "₹9.6L"],
                  ["CR sheet", "Pune", "120", "₹7.2L"],
                  ["MS plate", "Nashik", "36", "₹5.4L"],
                  ["GI coil", "Nashik", "64", "₹8.3L"],
                  ["Total", "", "268", "₹30.5L"],
                ].flatMap((row, r) =>
                  row.map((c, i) => (
                    <span key={`${r}-${i}`} className={r === 0 ? "head" : r === 5 && i === 3 ? "sum" : r === 5 ? "foot" : ""}>
                      {c}
                    </span>
                  )),
                )}
              </div>
            </div>
          </article>

          <article className="x-tile x-tile-sso">
            <span className="x-tag">One sign-in</span>
            <h3>Log in once. Open everything you&rsquo;re allowed to.</h3>
            <div className="x-hub" aria-hidden="true">
              <span className="x-hub-core">K</span>
              {APPS.slice(0, 8).map((a, i) => (
                <span key={a.name} className="x-hub-node" style={{ ["--i" as string]: i }}>
                  <AppDot app={a} size={26} />
                </span>
              ))}
            </div>
          </article>

          <article id="security" className="x-tile x-tile-india">
            <span className="x-tag">Hosted in India</span>
            <h3>Your data stays in Bangalore.</h3>
            <p>Encrypted connections, automatic backups, company sign-in and a full audit trail of every change.</p>
            <div className="x-radar" aria-hidden="true"><i /><i /><i /><b /></div>
          </article>
        </div>
      </section>

      {/* ── Closing ── */}
      <section className="x-final">
        <div className="x-beam x-beam-low" aria-hidden="true" />
        <h2>
          Bring your whole company
          <br />
          <em>into one place.</em>
        </h2>
        <Link href="/login" className="x-btn">Get started <Icon name="send" size={15} /></Link>
      </section>

      <footer className="x-foot">
        <span className="lg-brand"><BrandMark size={24} radius={7} /> {brand.name}</span>
        <span>© {new Date().getFullYear()} {brand.company} · Made in India</span>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/licenses">Open-source licences</Link>
        <Link href="/login">Sign in</Link>
      </footer>
    </div>
  );
}
