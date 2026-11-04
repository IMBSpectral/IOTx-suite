# IOTx Read: meeting notes for Google Meet, Zoom and Teams

A Chrome extension (Manifest V3) that records a call you're in on the web
(Google Meet, the Zoom web client, Microsoft Teams on the web, or any other
tab) so IOTx Meet can make its report: summary, chapters, action items,
key questions, speakers and scores. No bot joins the call.

## Install (Load unpacked)

1. Get the extension: in IOTx Meet open **Integrations** and choose
   **Download the extension**, then unzip it. (Or build it: see below.)
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Choose **Load unpacked** and pick the unzipped `read-extension` folder.
5. Pin **IOTx Read** to the toolbar (the puzzle icon → pin).

Chrome 116 or newer (Edge too).

## Sign in

1. In IOTx Meet → **Integrations**, choose **Connect browser extension**.
   It shows a pairing code (valid 10 minutes, works once) and a token.
2. Click the IOTx Read icon, check the server (`https://imbspectral.online`,
   or `http://localhost:3100` locally), type the code and press **Sign in**.
   You can paste the token instead.
3. To sign the extension out from anywhere, **Revoke** it in Integrations.

## Record a call

1. Join the call in its browser tab.
2. Click the IOTx Read icon and press **Start recording for notes**.
   - **Include my microphone** mixes your voice in, so both sides are heard.
     The first time, press **Allow microphone** and accept Chrome's prompt.
   - A **"Recording for notes"** badge shows on the call's page and the icon
     shows **REC** for as long as it records. Tell the people in the call.
3. Press **Stop** (in the popup or on the badge), or close the tab. The
   report appears in IOTx Meet a minute or two later (the popup links to it).

The sound goes up in 10-second pieces while you talk, so little is lost if
the browser crashes. The meeting title and the names of people in the call
are read from the page where the platform shows them (Google Meet does),
and the call is matched to today's calendar event by its link.

**Add notes to my next meeting:** the popup lists your next meetings from
IOTx Calendar. **Join + notes** opens the call and remembers which event it
is; press Start once you're in.

## Build

```
node scripts/build.mjs           # icons if missing, then dist/read-extension.zip
node scripts/build.mjs --icons   # redraw the icons
```

The zip is also copied to `apps/workspace/public/read-extension.zip`, which
Meet → Integrations offers for download. No npm packages are needed.

## How it works

- `popup.*`: sign-in, Start/Stop, your next meetings.
- `background.js` (service worker): the token, the API calls, tab capture
  (`chrome.tabCapture.getMediaStreamId`) and the offscreen document.
- `offscreen.*` + `recorder.js`: takes the tab stream and the mic, mixes them
  with Web Audio (and plays the call back so you still hear it), records
  Opus/WebM with MediaRecorder in 10-second chunks and uploads each one
  (`PUT /workspace/api/meet/ext/capture/<id>/chunk?seq=N`, retried).
- `content.js`: the badge and reading the title and names from the page.
- `mic.html`: asks for the microphone once (offscreen pages can't ask).

API (all with `Authorization: Bearer iotxr_…`): `POST /api/meet/ext/pair`
(no token: the pairing code), `GET /api/meet/ext/me`,
`GET /api/meet/ext/upcoming`, `POST /api/meet/ext/capture`,
`PUT …/capture/<id>/chunk?seq=N`, `PATCH|GET|DELETE …/capture/<id>`,
`POST …/capture/<id>/finish`.

## Privacy

Nothing is recorded until you press Start; the badge can be moved but not
hidden. Only the sound is recorded, never video. Recording people may need
their consent where you are: tell them, as the badge does.
