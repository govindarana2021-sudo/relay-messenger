# Relay Messenger

Real-time messenger built with Node.js and WebSockets.

## Run
    npm install
    npm start
Open http://localhost:3000 in two browsers (or two devices on the same network
via http://YOUR-LAN-IP:3000), pick different usernames, and chat.

## Files
- server.js          WebSocket server, static hosting, JSON-file message storage
- public/index.html  The client UI

## Notes
- Usernames have no passwords. Add authentication before real use.
- History is stored in data.json. Swap in SQLite or Postgres for production.
- Deploy to Render, Railway, or Fly.io (set PORT; use HTTPS so the client uses wss://).

## Hosting online
See DEPLOY.md for step-by-step Render + TURN instructions. Optional environment variables:
TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL (served to browsers at /ice-config).

ADMIN_USERNAME: makes whoever signs in with this exact username the single admin
for this deployment. There can only be one, and it's set here by you (the server
operator), never from inside the app. The admin gets a dashboard (Admin button in
the sidebar) showing presence, open reports, active calls and live broadcasts,
plus kick/ban and delete-any-message powers. The admin never gets camera access
to anyone without that person's explicit, revocable opt-in (Profile → "Allow the
admin to call me anytime"), and can only watch a user's camera if that user
chooses to start a broadcast. Leave ADMIN_USERNAME unset to disable all of this.

## Different devices on different networks (from your own PC)
Double-click start-online.bat (installs the tunnel tool on first run), then open the
https://....trycloudflare.com link it prints on every device. For video on strict networks,
fill in turn-settings.example.bat and rename it to turn-settings.bat.

## Delete and log out
- Delete: your own messages show a "Delete" link (removes the message for everyone).
- Log out: signs out and forgets your name on this device.
- Delete my account: removes your username and every message you sent or received.
You can only delete yourself; there are no passwords yet, so deleting other people is not allowed.

## Friends
- Type a username in "Add friend by username" to send a request.
- The other person sees Accept / Decline. You can Cancel a request you sent.
- Only friends can message or video-call each other.
- "Remove friend" (in the chat header) ends the friendship; old messages are kept and
  return if you become friends again.
- If two people request each other, they become friends automatically.

## Usernames
Letters (A-Z, a-z) and numbers (0-9) only, 1 to 20 characters. No spaces or symbols.
Enforced in the browser and again on the server.

## Photos, videos and files
Press "Attach" next to the message box. Photos and videos show inside the chat; other files are
download links. Max 25 MB (set MAX_UPLOAD_MB to change). Only the two people in the chat can open
a file. HTML/SVG and other risky types are always served as downloads, never as pages.

## Profile and stories
"My profile" (sidebar) lets you post a photo, video or text story. Friends see it for 24 hours
(set STORY_TTL_HOURS to change) by opening your Profile from the chat header; a ring appears on
your avatar in their list. Friends who are removed, and non-friends, cannot see it.
Note: free hosting has no permanent disk, so uploads are lost when the app restarts.

## Auto-answer calls
After you accept a friend's video call once, their later calls connect automatically without
the Accept prompt. This is stored on your device only. Turn it off per friend from the call
screen ("Auto-answer NAME") or from that friend's Profile. Removing a friend clears it.

## Camera/mic permission and calls when the app is closed
- Profile -> "Allow camera & mic" asks once. Choose Allow (not "Allow this time"); Chrome/Edge remember it.
  Browsers, not the app, control this: Firefox needs "Remember this decision", Safari needs
  Settings -> Websites -> Camera/Microphone -> Allow.
- Profile -> "Turn on call notifications": friends can ring you when Relay is closed. You get a
  notification; tapping it opens Relay, and the call connects (automatically if auto-answer is on for
  that friend). A web page cannot switch on a camera by itself while no tab is open - that is a
  browser security rule - so the notification tap is what brings the app back.
- Needs HTTPS (localhost is fine for testing). On iPhone, add Relay to the Home Screen first (iOS 16.4+).
- The server makes its own push keys on first start (vapid.json). On hosts that reset files, set
  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (generate with: npx web-push generate-vapid-keys) so they stay stable.
- A call keeps ringing for up to 45 s (caller side) / 60 s (server side).
