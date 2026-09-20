# Trust Me backend

Node.js 18+, no dependencies. Run `node server.js`, then open http://localhost:3000 (it serves the app at `/`).
Data is saved to `db.json`. Sign-in is by phone and a 6-digit code.

**Environment:** `PORT`, `DB_FILE`, `ORIGIN` (your site's address), `SHOW_OTP=0` (stop returning the code in the API).

**Endpoints** (send `Authorization: Bearer <token>` on everything except the first two):

| | |
|---|---|
| `POST /api/auth/request-otp` `{phone}` | Sends a code. Returns `devCode` while `SHOW_OTP` is on |
| `POST /api/auth/verify` `{phone, code, role, name, camp, batch, stream, cat, pkgName, pkgFee}` | Signs in or creates the account. Returns `{token, user}` |
| `GET/PATCH /api/me` | Your profile (name, camp, batch, stream, needs, pic) |
| `POST/PUT/DELETE /api/me/packages[/:id]` | Vendor packages |
| `GET /api/vendors?cat=&camp=&q=` · `GET /api/vendors/:id` | Browse vendors |
| `POST /api/bookings` `{vendorId, pkgId, when, where}` · `GET /api/bookings` | Corps member books; each side sees its own |
| `POST /api/bookings/:id/advance` | Vendor: accept, then finished. Corps member: release payment |
| `GET /api/messages` · `GET/POST /api/messages/:userId` | Inbox, thread, send `{to, text}` |

**Before real users:** add an SMS provider where the code is generated (Termii is a common Nigerian one) and set `SHOW_OTP=0`.
On Render's free plan the disk is wiped on restart, so use a persistent disk or a database. Payments are not real yet.
