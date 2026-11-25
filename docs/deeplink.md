# Phase 2 gate: cp.pt deep-link test (spec §8.0)

**Status (2026-11-22): step 2 (code check) showed the deep link cannot work as designed, so steps 1
and 3 were not run and no sale was ever created. Phase 2 was implemented with the prefilled search
link instead (see "Implemented alternative" below).**

Phase 2 hands the human a cp.pt link to pay for a sale the server prepared. That only works if
cp.pt can resume a sale from a URL.

## Procedure

1. **Browser only.** On cp.pt, go through a purchase up to the payment step. Record the URL and inspect
   `sessionStorage`, `localStorage` and cookies for `saleID` / `clientID`. Open the URL in a private window.
   Pass = the same sale and amount load.
2. **Code check.** In the site's JS bundles, search for `payment/redirect`, `saleID`, `clientID` and the
   `compra-online` routes to see whether the payment page reads the sale from URL parameters or from
   browser storage.
3. **API-created sale** (only if 1 passes). `POST K/sale` for the cheapest short Urbano trip, build the URL
   from step 1 with that `saleID`, open it in a fresh browser. Pass = cp.pt shows the API-created sale.
4. **Always** `DELETE K/sale/{saleID}` for every sale created during the test.

## Step 2 results: code check

Source: the cp.pt single-page app as served on 2026-11-22 (Vite build, entry `js/index-Dh0c3b1p.js`,
151 chunks). Chunk names change on every deploy.

### Ticket purchase flow

Routes, under `/{lang}/`:

| Route | Chunk | Role |
|---|---|---|
| `resultado-pesquisa` | `index-jZjaPceu.js` | Search results, train selection |
| `compra-bilhete/autenticacao` | (lazy) | Login or guest choice |
| `compra-online` | `index-Dgiuvv2L.js` | Passenger data, review, Checkout.com payment |
| `payment-processing` | (lazy) | Return from 3-D Secure / PayPal |
| `sucesso-bilhetes`, `erro-bilhetes` | (lazy) | Outcome pages |

### Where `compra-online` gets the sale

- `saleID` comes from the in-app cart (`items.saleID`) or from `localStorage.saleID`.
- `clientID` comes from `items.clientData.clientID` or from `localStorage.clientID`.
- On mount, the page resets its form when `localStorage.pathResults` is missing or a different
  `saleID` is stored. The results page sets `pathResults` when the user selects a train.
- The page reads two URL parameters only, `token` and `PayerID`. Both are for the PayPal return
  (`window.performDoubleCheckOnly`).
- Checkout.com is started in the browser with `CheckoutWebComponents({paymentSession, publicKey, ...})`.
  The payment session comes from the sale, and `GET K/sale/{saleID}/payment/redirect` (with
  `x-cp-client-id`) recovers it after a redirect.
- `clientUtils` also keeps `sessionStorage.cp_sale_session` = `{saleId, clientId, timestamp, expirationMinutes: 15}`.

The only page that reads `?saleID=` from the URL is the success page for travel-card ("título")
purchases, which then confirms that sale. It is not part of the ticket flow.

### Conclusion

The ticket checkout keeps the sale in cp.pt's own `localStorage` and `sessionStorage`. Nothing
outside cp.pt can write those, and no URL parameter replaces them. So a link cannot open an
API-created sale in the user's browser. Step 3 would fail by design. Step 1 would also fail, because
a private window starts with empty storage.

Under the spec's outcome rule (test 3 fails → do not implement purchase; agree an alternative), the
deep-link purchase design (§8.3–8.4) should not be built.

### Spec fallback: prefilled search link (verified)

The results page rebuilds the search from its URL when it has no in-memory state:

```
https://www.cp.pt/{pt|en}/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=YYYY-MM-DD&departureStation=94-30007&arrivalStation=94-2006[&endDate=YYYY-MM-DD]
```

Opened cold in a new browser tab on 2026-11-22 for 2026-11-30, it listed the same 20 options and
prices that `horarios` returns. The user then picks the train and buys on cp.pt as usual. It cannot
preselect a train or carry passenger data.

### Other findings

- `saleLink` on `/journeys` options is an external sale link (rendered as a Renfe button for
  international trips). It is unrelated to CP checkout.
- Alert pages are at `https://www.cp.pt/{lang}/detalhe-aviso/{friendlyUrlPath}`. This was verified
  with `greve-23a27-nov`.

## Implemented alternative

Agreed on 2026-11-22: phase 2 uses the prefilled search link and drops spec §8.1–8.5.

- `link_compra` takes an `option_id` from `horarios` (or `from`/`to`/`date`) and returns the cp.pt
  results URL, the selected train's times, train numbers and per-passenger fare, and an instruction
  naming the train to select. It warns when CP does not sell the option online.
- `horarios` also returns `cp_url` for the whole search.
- Links are built only on `https://www.cp.pt/`; anything else is refused (`UNSAFE_LINK`).
- Also verified on a cold load: `/en/` pages, `selectedClass=1`, `passageiros=2` and `endDate` (return tab).
  With more than one passenger, cp.pt shows totals while the tools report per-passenger prices; the
  instruction text says so.
- The server makes no ticketing-api calls. It does not create sales, hold seats, collect passenger,
  contact or fiscal data, or touch payment. `CP_ENABLE_PURCHASE` was removed.
- Not covered: preselecting the train, the time window (`after`/`before` is not passed to cp.pt), and
  fetching PDF tickets (they are emailed by CP and shown in MyCP).

