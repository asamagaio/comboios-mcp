# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it and
what an attacker could do with it. You should get a reply within a week.

Areas that matter most:

- the purchase flow (`src/pay.ts`, `api/pay.js`, `public/comprar.*`): anything that could charge a buyer
  twice, expose a buyer's details or ticket, or let someone act on another person's purchase;
- the encrypted tokens (`PAY_TOKEN_KEY`) and pre-fill links;
- anything that leaks CP's credentials or request bodies into logs.

## Scope

This project uses CP's undocumented website back end. Problems in CP's own systems should be reported to
CP, not here.
