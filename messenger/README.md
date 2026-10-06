# Relay Messenger

Real-time messenger built with Node.js and WebSockets.

## Run
    npm install
    npm start
Open http://localhost:3000 in two browsers (or two devices on the same network
via http://YOUR-LAN-IP:3000), pick different usernames, and chat.

## Files
- server.js          WebSocket server, accounts, uploads, static hosting, JSON-file storage
- public/index.html  The client UI

## Accounts and profiles (new in v7)
- Create account / Log in tabs. Passwords are hashed with scrypt (never stored in plain text).
  After logging in the browser keeps a session token, so you stay signed in until you press Log out.
  Logging in on a second device signs the first one out.
- Too many wrong passwords from one network locks that username for a minute.
- Accounts made before v7 have no password: log in with the username and type a NEW password
  (6+ characters); the first password chosen claims the account.
- Profile (click your picture, top left): change photo (cropped square, shrunk in the browser),
  display name, About text, change password, Light/Dark/Auto theme, Log out, Delete account (asks for your password).
- Friends see your photo, display name and About text; their profile opens from the (i) button in a chat.

## Messenger-style features
- Unread badges and a count in the browser tab title; chats sorted by latest message.
- "typing..." indicator, Active now / Active 5 min ago, and Sent / Seen under your last message.
- Photo messages (camera button; click a photo to enlarge), emoji picker, search chats.
- Date separators, mobile layout, dark mode.
- Auto-answer video calls (profile menu, per device, off by default): friends' calls connect without tapping Accept.

## Notes
- History is stored in data.json and pictures in the uploads folder (set DATA_DIR to move both).
  Swap in SQLite or Postgres plus object storage for production.
- Deploy to Render, Railway, or Fly.io (set PORT; use HTTPS so the client uses wss://).

## Hosting online
See DEPLOY.md for step-by-step Render + TURN instructions. Optional environment variables:
TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL (served to browsers at /ice-config).

## Different devices on different networks (from your own PC)
Double-click start-online.bat (installs the tunnel tool on first run), then open the
https://....trycloudflare.com link it prints on every device. For video on strict networks,
fill in turn-settings.example.bat and rename it to turn-settings.bat.

## Delete and log out
- Delete: your own messages show a "Delete" link (removes the message for everyone).
- Log out: signs out and ends this device's session.
- Delete account: removes your username, photo and every message you sent or received (needs your password).

## Friends
- Type a username in "Add friend by username" to send a request.
- The other person sees Accept / Decline. You can Cancel a request you sent.
- Only friends can message or video-call each other.
- "Remove friend" (in the chat header) ends the friendship; old messages are kept and
  return if you become friends again.
- If two people request each other, they become friends automatically.
