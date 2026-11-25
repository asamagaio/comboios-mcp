# Payment lab: buying a CP ticket outside cp.pt (2026-11-23)

**Result: it works.** A ticket was bought end to end from a local page (`lab/checkout/server.mjs`),
paid with MB WAY through CP's own Checkout.com payment session, confirmed by CP, and its PDF was
downloaded. The test bought one Regional ticket, Lisboa Santa Apolónia → Lisboa Oriente, train 4413,
2026-11-30, €1.60 (sale, reference and ticket numbers omitted).

This is an experiment, not part of the MCP server. It contradicts the spec's design principle ("no
self-hosted payment page") and runs CP's payment session on a page CP does not control; see Risks.

## Flow that worked

All calls go to the ticketing-api with the usual connect headers. Writes are never retried.

| # | Call | Notes |
|---|---|---|
| 1 | `POST K/sale` | Guest, no login, no `x-cp-client-id`. Body as on cp.pt: `quantity`, `travelDate`, `travelClass{code}`, `outwardTrip[]` (one per leg: `trainNumber`, station codes, `serviceCode`), `seatOptions: null`, `lang`. Returns `saleID`, `reference`, `clientData.clientID` (guest id), status `PENDING`. |
| 2 | `PUT K/sale/{id}/passengers` | `{salePassengers:[{passengerName, idtype?, passengerID?}]}`. Needs `x-cp-client-id`. |
| 3 | `PUT K/sale/{id}/client` | `{clientEmail, clientID, clientMobile, clientName}`. |
| 4 | `PUT K/sale/{id}/payment` | `{systemID:"CHECKOUT", inboundURL, useGWProxy:false, createToken:false, removeToken:false, channel:"BO"}`. **CP accepted `inboundURL = http://localhost:8790/return`.** Returns `paymentID`, `key` (Checkout.com public key, production), `session` (JSON string: `id`, `payment_session_token`, `payment_session_secret`). It also works before steps 2–3, which is unsafe (see below). |
| 5 | Browser | Load `https://checkout-web-components.checkout.com/index.js`, then `CheckoutWebComponents({paymentSession, publicKey, environment:"production"})` and `create("flow").mount(...)`. **The form loads on `http://localhost`** with card, MB WAY and PayPal. |
| 6 | `GET K/sale/{id}/payment` | Returns a bare string: `RETRY` before payment, `PROCEED` after the MB WAY approval. |
| 7 | `PUT K/sale/{id}/confirm` | What cp.pt's `payment-processing` page does after returning. Returned status `CONFIRMED`; the ticket's status became `CONFIRMED`. |
| 8 | `GET K/e-ticket/{saleID}/{reference}/{ticketID}` | PDF (1 page, ticket + invoice + QR). **Requires `x-cp-client-id`** (401 `SIV:API:401` without it). Ticket ids contain a hyphen (`NNNN-NNNNNNNN`). |
| — | `DELETE K/sale/{id}` | Cancels an unpaid sale. `GET .../payment` on a sale with no payment session answers 500 "Payment not found". |

With MB WAY the payment completes inside the form (`onPaymentCompleted`); there was no redirect, so the
return page only saw the `status` parameter the lab added itself. A card payment with 3-D Secure may
redirect to `inboundURL` with `cko-session-id` / `cko-payment-id` (not tested).

## What went wrong during the test, and the fixes

1. **The details form never sent anything.** The page read the Name field through a global `name`,
   which is `window.name` in browsers. Fixed with explicit lookups, and page errors are now shown.
2. **A payment session could be opened before the client data was set** (CP allows it). The user got
   an MB WAY request for a sale with no email and declined it. The lab now refuses to open payment until
   name and email are saved.
3. **The cancel guard allowed a delete when the payment status could not be read.** It now refuses,
   except for "Payment not found" (no payment was ever started).
4. **The PDF route rejected hyphenated ticket ids**, and the guest `clientID` lived only in memory,
   so a restart would have lost access to the PDF. The route is fixed and the sale's ids (no personal
   data) are kept in `lab/checkout/.lab-state.json` (mode 0600, git-ignored). For this test the ids
   were recovered from the running process with the Node inspector.

Five sales were created in total; four were cancelled unpaid, one was paid and confirmed.

## Risks that remain

- **Terms:** this runs CP's Checkout.com session on a page outside cp.pt. CP's terms and its contract
  with Checkout.com probably do not allow it. Fine for a personal experiment; ask CP before anything more.
- **Paid but not confirmed:** if `confirm` fails after payment, the money is taken without a ticket.
  The lab shows the reference and tells the user not to pay again; only CP support can resolve it.
  Not exercised in this test.
- **Untested:** card with 3-D Secure (redirect path), PayPal, multi-leg journeys, more than one passenger,
  returns, discounts, seat selection.
- **Unofficial API:** any of this can change without notice.

## If this moves into the MCP server

The safe shape is close to spec §8.4–8.5, with the payment page served locally instead of a cp.pt link:
elicitation before creating the sale and before opening payment; details required before the payment
session; one open sale at a time; state persisted (ids only); confirm exactly once after payment;
`NEEDS_ATTENTION` when payment is `PROCEED` but confirm fails; never cancel when the payment status
is unknown; PDFs saved locally.
