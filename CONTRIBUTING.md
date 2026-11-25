# Contributing

Thanks for helping. A few things keep this project working and polite to CP's servers.

1. **Run the tests.** `npm run build && npm test` must pass. Tests use recorded fixtures and make no network
   calls.
2. **Keep upstream load low.** Do not remove caching or the rate limiter, and do not add features that poll
   CP. Live checks (`npm run test:live`, `npm run probe`) are for occasional manual use.
3. **Verify against the live back end, not assumptions.** CP's API is undocumented. When you rely on a new
   field or behaviour, record a fixture (`npm run record-fixtures` or by hand, with personal data removed)
   and note what you verified in `docs/findings.md`.
4. **Purchases are sensitive.** Never test purchase changes against CP with automated runs. Use the mock in
   `lab/mock/` and the unit tests; any live purchase test must be a supervised, real purchase by a person,
   with the sale cancelled if it is not paid.
5. **No personal data in the repository**: no names, emails, ticket references or IDs in code, fixtures,
   docs or commit messages.

Open an issue before large changes, so we can agree on the approach.
