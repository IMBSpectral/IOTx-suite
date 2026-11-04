import Link from "next/link";
import { getBrand } from "@/lib/brand";
import { BrandMark } from "@/components/BrandProvider";
import "../legal.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy policy" };

const UPDATED = "2 November 2026";

/** Public privacy policy, including the Google user-data disclosures Google requires. */
export default function PrivacyPage() {
  const b = getBrand();
  const contact = b.supportEmail || process.env.FORGE_SYSTEM_MAILBOX || "";
  return (
    <main className="lgl">
      <div className="lgl-wrap">
        <Link href="/" className="lgl-top">
          <BrandMark size={28} /> {b.name}
        </Link>
        <h1>Privacy policy</h1>
        <p className="lgl-date">Last updated {UPDATED}</p>

        <p>
          {b.name} is a business software suite operated by {b.company} (&ldquo;we&rdquo;). It gives a company&rsquo;s staff one place for apps they build with AI, mail, documents, spreadsheets and accounting. This policy explains what information {b.name} handles, why, and the choices you have.
        </p>

        <h2>Information we handle</h2>
        <ul>
          <li><b>Account information:</b> your name, email address and profile picture from the sign-in method you use (for example Google), and your organization, role and permissions.</li>
          <li><b>Content you and your organization create:</b> apps, projects, chats with the AI, documents, settings and files you upload.</li>
          <li><b>Connected mail:</b> when you or your administrator connect a mailbox, the messages, attachments and folders of that mailbox, so they can be shown and acted on in {b.name}.</li>
          <li><b>Connected Google files:</b> when you connect Google Drive, the list of your Google Docs, Sheets and Slides, and the contents of files you open or link to an app.</li>
          <li><b>Usage and technical data:</b> sign-in times, security events, and server logs needed to run and protect the service.</li>
        </ul>

        <h2>How we use Google user data</h2>
        <p>{b.name} asks for Google access only when you choose to connect it, and uses it only for the features you see:</p>
        <ul>
          <li><b>Gmail (read, send and organize):</b> to show your mail in {b.name}&rsquo;s Mail app, keep read and unread status in step with Gmail, send the replies and messages you write, and, when you ask, summarize a message, draft a reply or label it.</li>
          <li><b>Google Drive (read-only):</b> to list your Google Docs, Sheets and Slides and show previews inside {b.name}.</li>
          <li><b>Google Sheets (read-only):</b> to show a sheet&rsquo;s values, and to let an app you build read a sheet you explicitly linked to it, so its screens stay up to date.</li>
        </ul>
        <div className="lgl-box">
          <p>
            {b.name}&rsquo;s use and transfer of information received from Google APIs adheres to the{" "}
            <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. We do not sell Google user data, use it for advertising, or use it to train general-purpose AI models. People at {b.company} do not read it, except with your permission for support, where needed for security or abuse investigations, or to comply with the law.
          </p>
        </div>

        <h2>AI features</h2>
        <p>
          When you use an AI feature (for example asking the assistant, building an app, or asking for a summary of an email), the content needed for that request is sent to our AI provider, Anthropic, to produce the answer. It is processed under Anthropic&rsquo;s commercial terms, which do not allow it to be used to train their models. Mail content is only sent when you or your administrator use an AI action on it.
        </p>

        <h2>Meetings, recordings and transcripts</h2>
        <ul>
          <li>Meetings are recorded, transcribed or summarized only when someone turns that on. In online meetings everyone is shown a notice when recording or AI notes start; for in-person recordings, the person recording must tell those present. The person who turns it on is responsible for having participants&rsquo; consent where the law requires it.</li>
          <li>To make transcripts and captions, meeting audio is sent to our speech provider, OpenAI, under its business terms, which do not allow it to be used to train its models. Summaries are written by Anthropic as described above.</li>
          <li>Recordings, transcripts and notes are visible to the people the host shares them with, and are deleted when the meeting is deleted or the organization&rsquo;s account is closed.</li>
          <li>The {b.name} browser extension reads a meeting page only while you have asked it to take notes, and sends the audio and captions to {b.name} for that purpose.</li>
        </ul>

        <h2>People, work time and sign-ins</h2>
        <ul>
          <li>Your organization can record each person&rsquo;s department, manager, job title and HR details (phone, employee code, joining date). HR details are visible only to administrators, the person, and their managers.</li>
          <li>Time off requests, clock-in and clock-out times and daily work reports are visible to the person, their managers and administrators. The reason for time off is not shown to colleagues.</li>
          <li>When you sign in we record the time, the sign-in method, your IP address and your browser and device type, to protect your account. Administrators can see this for people in their organization.</li>
        </ul>

        <h2>Where data is stored and who processes it</h2>
        <ul>
          <li>On our servers in Bangalore, India (DigitalOcean), or on your organization&rsquo;s own server when {b.name} is installed there.</li>
          <li>Passwords for connected mailboxes, Google access tokens and other credentials are encrypted at rest. All connections use HTTPS.</li>
          <li>We share data only with the providers needed to run the service (hosting, AI and speech-to-text, and the email and Google services you connect), and when required by law. We do not sell personal information.</li>
        </ul>

        <h2>Your choices and how to delete data</h2>
        <ul>
          <li><b>Disconnect any time:</b> disconnecting a mailbox in {b.name} removes its stored credentials and the copies of its messages from {b.name}. Disconnecting Google Drive revokes {b.name}&rsquo;s access and deletes the stored token. You can also remove access from your Google Account at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">myaccount.google.com/permissions</a>.</li>
          <li><b>Your account:</b> your organization&rsquo;s administrator can remove your account; you can ask us to delete your personal information{contact ? <> by writing to <b>{contact}</b></> : ""}.</li>
          <li><b>Retention:</b> we keep data while your organization uses {b.name}, and delete it within 30 days after the organization&rsquo;s account is closed, except where the law requires us to keep it longer.</li>
        </ul>

        <h2>Security</h2>
        <p>Access is controlled by your organization&rsquo;s roles and permissions, sign-in can require a second step, every change is recorded in an audit log, and data is backed up regularly.</p>

        <h2>Changes and contact</h2>
        <p>
          We will update this page when our practices change and show the new date at the top.{contact ? <> Questions: <b>{contact}</b>.</> : null}
        </p>

        <footer>
          <span>© {new Date().getFullYear()} {b.company}</span>
          <Link href="/terms">Terms of service</Link>
          <Link href="/">Home</Link>
        </footer>
      </div>
    </main>
  );
}
