import Link from "next/link";
import { getBrand } from "@/lib/brand";
import { BrandMark } from "@/components/BrandProvider";
import "../legal.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Terms of service" };

const UPDATED = "2 November 2026";

/** Public terms of service. */
export default function TermsPage() {
  const b = getBrand();
  const contact = b.supportEmail || process.env.FORGE_SYSTEM_MAILBOX || "";
  return (
    <main className="lgl">
      <div className="lgl-wrap">
        <Link href="/" className="lgl-top">
          <BrandMark size={28} /> {b.name}
        </Link>
        <h1>Terms of service</h1>
        <p className="lgl-date">Last updated {UPDATED}</p>

        <p>
          These terms apply to your use of {b.name}, provided by {b.company}. By signing in you agree to them. If your organization has a separate written agreement with us, that agreement takes precedence.
        </p>

        <h2>Your account</h2>
        <ul>
          <li>Your organization&rsquo;s administrators decide who has access and what each person can do.</li>
          <li>Keep your sign-in secure. Tell your administrator or us straight away if you think someone else has used your account.</li>
        </ul>

        <h2>Acceptable use</h2>
        <p>Don&rsquo;t use {b.name} to break the law, send spam or bulk unsolicited email, harm or gain unauthorized access to other systems, or build apps that do any of these things.</p>

        <h2>Your content</h2>
        <ul>
          <li>You and your organization own the content you create and the data you connect. You give us permission to host and process it only to provide the service.</li>
          <li>Apps built with the AI Builder are yours. You are responsible for how you use and publish them.</li>
        </ul>

        <h2>Our platform</h2>
        <ul>
          <li>{b.name}, its software, design and documentation belong to {b.company} or its licensors. These terms give your organization the right to use it while your subscription lasts; they don&rsquo;t transfer ownership.</li>
          <li>{b.name} includes open-source software, each part under its own licence. The list is on the <Link href="/licenses">open-source licences</Link> page. Apps built with the AI Builder may also include open-source packages, which stay under their own licences.</li>
          <li>Don&rsquo;t copy, resell or reverse-engineer the platform, or use it to build a competing product, except where the law allows it.</li>
        </ul>

        <h2>Trademarks</h2>
        <p>
          Google, Gmail, Google Drive, Claude, OpenAI, Zoom, Microsoft Teams, Slack, Notion, Stripe and other product names are trademarks of their owners. We name them only to describe
          integrations; {b.name} is not affiliated with or endorsed by them.
        </p>

        <h2>Connected services</h2>
        <p>When you connect services such as Gmail, Google Drive or another mailbox, your use of those services stays subject to their own terms. Our use of the data is described in the <Link href="/privacy">privacy policy</Link>.</p>

        <h2>AI output</h2>
        <p>AI-generated summaries, drafts, apps and answers can be wrong. Review them before relying on them, especially for financial, legal or accounting decisions.</p>

        <h2>Availability and changes</h2>
        <p>We work to keep {b.name} available and secure, back it up regularly, and may update features over time. We will tell administrators in advance about changes that materially affect them.</p>

        <h2>Ending use</h2>
        <p>Your organization can stop using {b.name} at any time and export its data. We may suspend access that breaks these terms. On closure, data is deleted as described in the privacy policy.</p>

        <h2>Copyright complaints</h2>
        <p>
          If you believe content hosted on {b.name} infringes your copyright or other rights, write to {contact ? <b>{contact}</b> : "us"} with the address of the content, the work you believe is
          infringed, and your contact details. We review every notice and remove infringing content promptly.
        </p>

        <h2>Your responsibilities</h2>
        <p>
          Your organization is responsible for the content and data it puts into {b.name} and for having the right to use them. If a claim is brought against {b.company} because of that content,
          or because the service was used in breach of these terms, your organization will cover the reasonable costs of that claim.
        </p>

        <h2>Liability</h2>
        <p>To the extent the law allows, {b.company} is not liable for indirect or consequential losses, and our total liability is limited to the fees paid for the service in the 12 months before the claim.</p>

        <h2>Governing law</h2>
        <p>These terms are governed by the laws of India. Disputes are subject to the courts named in your organization&rsquo;s agreement with us, or otherwise the courts where {b.company} is registered.</p>

        <h2>Contact</h2>
        <p>{contact ? <>Questions about these terms: <b>{contact}</b>.</> : <>Questions about these terms: contact your account manager.</>}</p>

        <footer>
          <span>© {new Date().getFullYear()} {b.company}</span>
          <Link href="/privacy">Privacy policy</Link>
          <Link href="/licenses">Open-source licences</Link>
          <Link href="/">Home</Link>
        </footer>
      </div>
    </main>
  );
}
