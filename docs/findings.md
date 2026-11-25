# Verification log (2026-11-22)

All read endpoints from spec v2 §5 were called live on 2026-11-22 and returned 200
(`npm run probe`). The items below either settle a point the spec marked [não verificado] or
correct the spec. Fixtures recorded the same day are in `test/fixtures/`.

## Settled

| Spec item | Finding |
|---|---|
| `classes:[1,2]` in one `/journeys` call (§5.3, §11) | Works. Lisboa SA → Porto Campanhã returned `basePrices` for class 1 and 2 on each AP/IC option. `precos` still keeps the per-class fallback for safety. |
| `timeLimit.limitType` | 0 = whole day, window ignored. 2 = departure within `[startTime, endTime]`. 1 = appears to filter by arrival time (18:00–21:00 returned trains departing 12:30–18:00). The server uses 2 whenever `after`/`before` is given. |
| Price per passenger or total | Per passenger. `quantity: 2` returned the same `centsValue` as `quantity: 1`. The tool reports `prices_eur` per passenger and `total_eur` when passengers > 1. |
| `username` | `/rules` publishes `wks_username = "SivNetTicket"` (different casing). The server keeps the site's `sivNetticket` constant. |
| IP fallback for a train that does not run | 200 with every field `null` (not 404). Treated as not found. |
| IP `Observacoes` | Carries expected time as `Hora Prevista:23:44`; parsed into `expected`. |
| Alerts field map (§5.7) | Matches the spec. Every field also carries a `label`, so the label fallback is usable. |
| Alert public URL (§5.7) | `https://www.cp.pt/{lang}/detalhe-aviso/{friendlyUrlPath}` (route in the site code; page opened and checked). `perturbacoes` returns it as `url`. |

## Corrections to the spec

1. **Service codes do not come from `/trains`.** `/trains` uses numeric codes (`"1"` = Alfa Pendular,
   `"2"` = Intercidades, `"45"` = Urbano de Lisboa), while `/journeys` and the live boards use letter codes
   (`AP`, `IC`, `R`, `U`). The letter codes are published by `GET K/sale/configuration?configID=200&lang=pt`
   as `configCodes[]` with `type: "SERVICE"`: AP, IC, IR, IR-M, R, U, ESP, IN. The server builds the
   `services` list from there at startup. If that call fails, the description says so and codes are not validated.
2. **`saleLink`** exists on every `outwardTrip` item (null in all responses seen). It may be relevant to the
   phase-2 deep link; see `docs/deeplink.md`.
3. Coimbra (A) is not in `/stations`; only Coimbra-B (94-36004).
4. There are only three stations whose name starts with "Lisboa" (Santa Apolónia, Oriente, Rossio).
   "Lisboa" alone is therefore reported as ambiguous rather than aliased.

## Still unverified

- `supression` values (none non-null seen); `cancelled` is inferred from a non-null value and the raw value is returned.
- `occupancy` scale, train `status` values other than `IN_TRANSIT`/null, `priceType` 100/104.
- Alert `JournalArticle66157978` (linked train) shape; returned raw when non-empty.
- Everything in spec §8 (purchase).
