# Friends V2: Mutual Requests + Friend Codes (Implementation Plan)

## Overview

- **Terminology note:** older drafts may say “signaling server”. In this repo that component is the **Beacon** (`beacon-server/`).
- **Status note:** this is a planning doc; parts of it may already be implemented in code, while UI work may still be pending.

- **Mutual friends**: Adding a friend sends a **friend request**; the other user gets a notification and can **Accept** or **Decline**. On the requester’s side it shows **pending** until accepted/declined. No friend is added until both sides agree.
- **Offline handling**: Pending friend requests and code redemptions are stored on the **signaling server** and delivered when the user comes **online** (WebSocket).
- **Friend code**: A **+** button at the top of the friends list creates a short **shareable code** (like server invite). Anyone who uses the code sends a “add me via your code” request to the code owner. The code can be **revoked**. The owner can **accept** or **decline** each redemption (when online; if offline, redemptions queue on the server).

---

## 1. Data model

### 1.1 Signaling server (source of truth for pending state)

- **Friend requests** (direct “Add friend” from server member):
  - `(from_user_id, to_user_id, from_display_name?, created_at)`
  - Stored until: accepted, declined, or (optional) expiry.
- **Friend codes** (like invite tokens):
  - `owner_user_id`, `code` (short, e.g. 8 chars), `created_at`, `revoked: bool`.
  - One active code per user (create = replace or reuse; revoke = set revoked).
- **Code redemptions** (someone used your code):
  - `code_owner_id`, `redeemer_user_id`, `redeemer_display_name`, `code`, `created_at`.
  - Stored until owner accepts or declines.

Friends list (mutual) stays **local** on each client (in `friends.json` and in .key export). The server does **not** store the final “friends list”; it only stores:
- Pending friend requests (outgoing + incoming),
- Friend codes and their revoked state,
- Pending code redemptions for the code owner.

### 1.2 Client (Tauri / frontend)

- **friends** (local): list of `user_id` (mutual friends only).
- **pending_outgoing** (can be local or from server): user_ids to whom I sent a request that is not yet accepted/declined. Prefer “fetch from server when online” so it’s consistent across devices.
- **pending_incoming** (from server only): delivered via WebSocket when online; show Accept/Decline in UI.
- **pending_code_redemptions** (from server only): delivered via WebSocket when online; show Accept/Decline per redemption.

---

## 2. Signaling server changes

### 2.1 New state (in-memory; optional Postgres later)

- **Friend requests**:  
  `HashMap<(String, String), FriendRequest>` keyed by `(from_user_id, to_user_id)`  
  or list `Vec<FriendRequest>` with lookup by from/to.
- **Friend codes**:  
  `HashMap<String, FriendCode>` keyed by `code` (and/or by `owner_user_id` if one code per user).  
  `FriendCode { owner_user_id, code, created_at, revoked }`.
- **Code redemptions**:  
  `Vec<CodeRedemption>` or map keyed by (owner_id, redeemer_id).  
  `CodeRedemption { code_owner_id, redeemer_user_id, redeemer_display_name, code, created_at }`.

### 2.2 Delivering to a user by user_id

- Presence state already maps `user_id` → set of `conn_id` (from `PresenceHello`).
- We need **conn_id → WebSocketSender** so we can “send to user X”.
- **Option A**: When handling WebSocket messages we have `(conn_id, sender)`. In `PresenceHello` handler, register `(user_id, conn_id, sender)` in a new structure, e.g. `UserConnections: HashMap<String, Vec<(ConnId, WebSocketSender)>>`. On disconnect (in `ws.rs`), unregister that conn_id from UserConnections (and from presence).
- **Option B**: Store only conn_id in presence; keep a separate `conn_id -> WebSocketSender` map in the WS handler and pass it into the app state so “send to user” can resolve user_id → conn_ids → senders.

Recommended: **Option A** – add `UserConnections` (or extend presence) so that when we have a pending friend request or code redemption for `to_user_id`, we look up senders for that user and push a WS message.

### 2.3 New WebSocket message types (in `SignalingMessage`)

- **FriendRequestIncoming**  
  `{ from_user_id, from_display_name, created_at }`  
  → Sent to `to_user_id` when they’re online (or on connect; see below).

- **FriendRequestAccepted**  
  `{ from_user_id, to_user_id }`  
  → Sent to `from_user_id` (requester) when `to_user_id` accepts. Client then adds `to_user_id` to local friends.

- **FriendRequestDeclined**  
  `{ from_user_id, to_user_id }`  
  → Sent to `from_user_id` when `to_user_id` declines. Client removes pending outgoing.

- **FriendCodeRedemptionIncoming**  
  `{ redeemer_user_id, redeemer_display_name, code, created_at }`  
  → Sent to code owner when they’re online (or on connect).

- **FriendCodeRedemptionAccepted**  
  `{ code_owner_id, redeemer_user_id }`  
  → Sent to redeemer: “code owner added you.” Redeemer adds code_owner_id to local friends. Owner adds redeemer to local friends (and we can send a generic “accepted” to owner for UI).

- **FriendCodeRedemptionDeclined**  
  `{ code_owner_id, redeemer_user_id }`  
  → Sent to redeemer so they can drop pending state.

- **FriendPendingSnapshot** (on connect / on request)  
  `{ pending_incoming: [{ from_user_id, from_display_name, created_at }, ...], pending_code_redemptions: [{ redeemer_user_id, redeemer_display_name, code, created_at }, ...], pending_outgoing: [user_id, ...] }`  
  → So when the client connects (e.g. after PresenceHello), server sends all pending data for that user in one message.

### 2.4 New HTTP API (REST)

- **POST /api/friends/requests**  
  Body: `{ to_user_id: string }`.  
  Creates a friend request from current user (identified by session or by a token in header – we need to decide how to authenticate “current user” in REST; see below).  
  If target is online, also push **FriendRequestIncoming** over WS. If not, store only; they get it on next connect via **FriendPendingSnapshot**.

- **POST /api/friends/requests/accept**  
  Body: `{ from_user_id: string }`.  
  “I (to_user_id) accept the request from from_user_id.” Remove request, notify from_user_id with **FriendRequestAccepted**.

- **POST /api/friends/requests/decline**  
  Body: `{ from_user_id: string }`.  
  Remove request, notify from_user_id with **FriendRequestDeclined**.

- **GET /api/friends/requests** (optional)  
  Returns `{ pending_incoming, pending_outgoing, pending_code_redemptions }` for the current user. Useful for polling; preferred is WS **FriendPendingSnapshot** on connect.

- **POST /api/friends/codes**  
  Body: `{}` or `{ revoke_previous: true }`.  
  Create a new friend code for current user (short random code, e.g. 8 chars). If one exists and not revoked, return existing or replace based on policy.  
  Response: `{ code, expires_at? }`.

- **POST /api/friends/codes/revoke**  
  Body: `{}`.  
  Revoke current user’s friend code (set revoked = true; existing redemptions still pending until accept/decline).

- **POST /api/friends/codes/redeem**  
  Body: `{ code: string, redeemer_user_id: string, redeemer_display_name: string }`.  
  Validate code (exists, not revoked, not expired). Create a **code redemption** record. If code owner is online, push **FriendCodeRedemptionIncoming**; else they get it on connect via **FriendPendingSnapshot**.

- **POST /api/friends/codes/redemptions/accept**  
  Body: `{ redeemer_user_id: string }`.  
  Code owner accepts. Add redeemer to owner’s friends (client-side only); notify redeemer with **FriendCodeRedemptionAccepted** so they add owner. (We don’t store “friends” on server; we only notify both sides to update local lists.)

- **POST /api/friends/codes/redemptions/decline**  
  Body: `{ redeemer_user_id: string }`.  
  Remove redemption, notify redeemer with **FriendCodeRedemptionDeclined**.

**Authentication for REST**: Today the signaling server has no notion of “logged-in user” for REST. Options: (1) Use a signed token (e.g. JWT or opaque) that the client gets from Tauri after proving identity, and send it in `Authorization` for friend API; (2) Use a temporary token bound to user_id that the client sends in a header. For minimal change, we could use **user_id + signature** in a custom header (client signs with identity private key), or a **short-lived token** issued by the app (Tauri) that encodes user_id. The plan assumes we add **some** way to identify “current user” for these endpoints (e.g. `X-User-Id` + `X-User-Signature` or `Authorization: Bearer <opaque_token>`).

### 2.5 When user comes online (PresenceHello)

- After updating presence, look up **pending_incoming** friend requests for this `user_id`.
- Look up **pending_code_redemptions** for this `user_id` (as code owner).
- Optionally fetch **pending_outgoing** (requests I sent that are still pending).
- Send **FriendPendingSnapshot** to this connection with all of the above so the client can show “You have N friend requests” and “N people used your code” and “Pending: …” for outgoing.

### 2.6 Optional: Postgres persistence for friend state

- If the server restarts, in-memory pending requests and code redemptions would be lost. For production, add tables, e.g. `friend_requests`, `friend_codes`, `friend_code_redemptions`, and read/write in the same way as `invite_tokens` (with optional Postgres backend). Schema can mirror the in-memory structures above.

---

## 3. Client (Tauri + frontend) changes

### 3.1 Tauri

- **Remove** “instant add” from `add_friend`; instead, call signaling **POST /api/friends/requests** with `to_user_id`. Optionally keep a local “pending_outgoing” list or rely on server snapshot.
- New commands (or use HTTP from frontend):
  - **createFriendCode()** → POST /api/friends/codes, return code.
  - **revokeFriendCode()** → POST /api/friends/codes/revoke.
  - **redeemFriendCode(code)** → POST /api/friends/codes/redeem (with current user_id and display_name).
  - **acceptFriendRequest(from_user_id)** → POST /api/friends/requests/accept; then **add to local friends** (call existing local add_friend or new internal add_friend_only).
  - **declineFriendRequest(from_user_id)** → POST /api/friends/requests/decline.
  - **acceptCodeRedemption(redeemer_user_id)** → POST accept; then add redeemer to local friends.
  - **declineCodeRedemption(redeemer_user_id)** → POST decline.

- When the app receives **FriendRequestAccepted** (I’m the requester), add `to_user_id` to local friends (persist to friends.json).
- When the app receives **FriendCodeRedemptionAccepted** (I’m the redeemer), add `code_owner_id` to local friends.

So the **friends list** remains local; the server only drives **who to add** via accept notifications.

### 3.2 WebSocket (ServerSyncBootstrap or dedicated friend channel)

- In the same WS that already does PresenceHello, handle new message types:
  - **FriendPendingSnapshot** → update React state (pendingIncoming, pendingOutgoing, pendingCodeRedemptions).
  - **FriendRequestIncoming** → append one item to pendingIncoming (or refresh snapshot).
  - **FriendRequestAccepted** / **FriendRequestDeclined** → update pendingOutgoing and, on accept, add to local friends (via Tauri or context).
  - **FriendCodeRedemptionIncoming** → append to pendingCodeRedemptions.
  - **FriendCodeRedemptionAccepted** / **FriendCodeRedemptionDeclined** → update UI; on accept (as redeemer), add code owner to local friends.

### 3.3 Friends context / UI

- **Friends list**: still shows mutual friends (from local list). Add a **Pending** section:
  - **Pending outgoing**: “Request sent to X” (with option to cancel if we add that API).
  - **Pending incoming**: “X wants to be friends” with **Accept** / **Decline**.
  - **Pending code redemptions**: “X used your friend code” with **Accept** / **Decline**.
- **Add friend (from server member)**:
  - Replaces “Add to friends” with “Send friend request” (or keep label “Add friend” but action = send request). When the other accepts, both get each other in their list.
- **Friend code**:
  - **+** button at top of friends panel → opens a small UI: “Your friend code: **XXXX-XXXX**” (or short code), **[Copy]**, **[Revoke code]**.
  - **Add by code**: input “Enter friend code” + **[Add]** which calls redeem. Then the code owner sees a redemption in pending and can accept/decline.
- **Export/import**: Friends list in .key file remains the list of **mutual** friend user_ids; no change to format. Pending state is not exported (refetched from server when online).

---

## 4. Flow summary

1. **Direct request**: A clicks “Add friend” on B → client calls POST /api/friends/requests with B’s user_id. Server stores (A, B). If B is online, B gets **FriendRequestIncoming**; else B gets **FriendPendingSnapshot** on next connect. B sees “A wants to be friends”, Accept/Decline. On Accept, server sends **FriendRequestAccepted** to A; A and B both add each other locally. On Decline, server sends **FriendRequestDeclined** to A; A removes B from pending outgoing.
2. **Friend code**: A creates code (POST /api/friends/codes), shares “XXXX”. B redeems (POST /api/friends/codes/redeem). Server creates redemption for owner A. If A is online, A gets **FriendCodeRedemptionIncoming**; else on connect **FriendPendingSnapshot**. A accepts/declines. On accept, A adds B locally; server sends **FriendCodeRedemptionAccepted** to B; B adds A locally. A can revoke the code anytime (POST revoke); new redemptions then fail; existing pending redemptions can still be accepted/declined.
3. **Offline**: All pending requests and redemptions live on the server and are delivered when the user connects (PresenceHello) via **FriendPendingSnapshot**.

---

## 5. Files to touch (concise)

| Layer | File(s) | Change |
|-------|---------|--------|
| Signaling | `main.rs` | Add `SignalingMessage` variants; add `UserConnections` or equivalent; register friend HTTP routes; in WS disconnect unregister user connection. |
| Signaling | `state/` (new or events) | Add friend_requests, friend_codes, code_redemptions; add user_id → senders map for delivery. |
| Signaling | `handlers/http.rs` or new `handlers/friends.rs` | Implement friend request and friend code REST endpoints. |
| Signaling | `handlers/message.rs` | On PresenceHello, register conn for user_id; after presence logic, send FriendPendingSnapshot for that user_id. |
| Signaling | `handlers/ws.rs` | On disconnect, unregister conn from user connections. |
| Client | `lib/tauri.ts` | Add createFriendCode, revokeFriendCode, redeemFriendCode, acceptFriendRequest, declineFriendRequest, acceptCodeRedemption, declineCodeRedemption (or call HTTP from frontend with auth). |
| Client | `ServerSyncBootstrap.tsx` | Handle FriendPendingSnapshot, FriendRequestIncoming, FriendRequestAccepted, FriendRequestDeclined, FriendCodeRedemptionIncoming, FriendCodeRedemptionAccepted, FriendCodeRedemptionDeclined; update FriendsContext or dedicated FriendRequestsContext. |
| Client | `FriendsContext.tsx` | Add pendingIncoming, pendingOutgoing, pendingCodeRedemptions; add accept/decline and code create/revoke/redeem; when FriendRequestAccepted / FriendCodeRedemptionAccepted, add user to local friends (invoke Tauri to persist). |
| Client | `ServerListPage.tsx` | Friends panel: + button (create code UI), “Add by code” input, Pending outgoing/incoming and code redemptions with Accept/Decline. |
| Client | `UserProfileCard.tsx` | Change “Add to friends” to “Send friend request” (call new API); show “Pending” if request already sent. |

---

## 6. Authentication for friend API

The signaling server currently does not authenticate REST callers by user. For friend APIs we need to know “who is making this request”. Options:

1. **Opaque token**: Tauri generates a short-lived token (e.g. HMAC(user_id + expiry)) and stores a shared secret with the server (or server has a public key and Tauri signs). Server validates token and extracts user_id. Requires server config or key.
2. **Header with user_id + signature**: Client sends `X-User-Id` and `X-User-Signature` (signature over a nonce or timestamp with identity private key). Server has access to public keys or only user_id and accepts any request for that user_id (weaker). Or server stores user_id → public key and verifies signature.
3. **No auth (dev only)**: Trust `X-User-Id` or body user_id. Easiest; acceptable only for trusted/private deployments.

Recommendation: start with **X-User-Id** (and optionally **X-User-Signature** if we add key storage on server) so the server can associate requests with a user; then add proper signing later if needed.

**Implemented (A+):** X-User-Id + X-Timestamp + X-Signature (HMAC-SHA256 of `user_id + timestamp` with shared secret). Server env: `SIGNALING_FRIEND_API_SECRET`; client uses same secret. Timestamp valid 300s; constant-time signature compare.

**Mutual auto-accept:** If A sends request to B and B already sent request to A, server auto-accepts both (removes B→A, sends FriendRequestAccepted to both).

---

## 7. Order of implementation

1. **Signaling**: Add state (friend_requests, friend_codes, code_redemptions, user_id → senders). Add WS message types and FriendPendingSnapshot on PresenceHello; add HTTP routes (with minimal auth).
2. **Signaling**: Implement create/revoke/redeem code and request send/accept/decline and redemption accept/decline; implement delivery to online users and snapshot on connect.
3. **Client**: Add friend API calls (from frontend or Tauri); extend ServerSyncBootstrap to handle new WS messages and update context.
4. **Client**: FriendsContext: pending state, accept/decline, code create/revoke/redeem; on accept notifications, add to local friends via Tauri.
5. **Client**: UI: + button and code modal, “Add by code” field, Pending sections with Accept/Decline; UserProfileCard “Send friend request” and “Pending”.

This plan keeps mutual friends as a two-step (request → accept/decline), keeps friend codes like server invites (create, share, revoke), and uses the signaling server to hold and deliver pending state until users come online.
