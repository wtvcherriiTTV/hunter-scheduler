# Hunt Scheduler

A small web app where hunters request a time to hunt on your property. If two requests overlap (same area, overlapping hours), a random draw picks the winner. Includes an admin panel.

No dependencies. Needs Node 18 or newer.

## Run it

    node server.js

Then open http://localhost:3000 (hunters) and http://localhost:3000/admin (you).

Options (environment variables): `PORT`, `DATA_DIR`, `TRUST_PROXY=1` (if behind a reverse proxy), `COOKIE_SECURE=1` (if served over HTTPS).

## Admin login

The first time the server starts it creates `data/db.json` with the admin account:

- Username: `admin`
- Password: `airgeouk!`

Change it under Admin > Account. The password is stored hashed (scrypt), never in plain text, and the default only seeds a brand-new database. If you forget the new password, delete `data/db.json` (this wipes all requests) or edit the admin entry out of it and restart.

## How the draw works

1. Hunters submit a date, start/end time, and (if you've set up areas) an area. They get a 6-character code to check or cancel their request.
2. Requests stay **pending** until a draw runs. The draw runs automatically N hours before the start of the hunt date (default 24, configurable) or whenever you press the button in the admin panel.
3. In a draw, for each date:
   - Requests that overlap an already confirmed hunt are declined.
   - Requests with no overlap are confirmed.
   - For overlapping requests, one is picked with a cryptographically secure random number. Anyone whose time overlaps the winner is declined. Anyone left who doesn't overlap the winner is re-checked (so A-B-C chains resolve fairly).
4. Every random draw is recorded in the Draw log (entrants and winner).

Hunters never see each other's names, only "Confirmed", "Pending", or "Contested" slots on the public schedule.

## Admin panel

- Requests: filter by status or date, approve / decline / re-queue / delete, run the draw for one date or all dates
- Areas: optional hunting areas (North Woods, Back 40...). Conflicts only count within the same area
- Settings: property name, rules text, max hunt length, auto-draw timing
- Draw log: who was in each draw and who won
- Account: change username and password

Times are interpreted in the server's time zone.

## Putting it online

Run it behind HTTPS (Caddy, nginx, or a host like Render/Fly/Railway with a persistent disk for `data/`). Set `COOKIE_SECURE=1`, and `TRUST_PROXY=1` if a proxy sits in front. Back up `data/db.json` occasionally.
