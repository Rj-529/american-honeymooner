# American Honeymooner

Marketing site for American Honeymooner — an old-money-inspired honeymoon brand experience.

## Current stack (launched)

- Single-page static site (`index.html`) preserving the existing visual identity
- Hosted on [Cloudflare Pages](https://pages.cloudflare.com/)
- Automatic deploys from the `main` branch via GitHub → Cloudflare Pages

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Build command | *(empty — static site)* |
| Build output directory | `/` |

### Local preview

Open `index.html` in a browser, or:

```bash
npx --yes serve .
```

### Deploy workflow

1. Edit and commit on `main` (or merge a PR into `main`).
2. Cloudflare Pages builds and publishes automatically.
3. Preview deployments are available for pull requests when enabled in the project.

Do not commit secrets (API tokens, passwords, Shopify keys) to this repository.

## Site navigation (prepared)

The live page already surfaces destinations, guide, journal, shop, and “Build your Dream Honeymoon” entry points. As features ship, keep these as first-class destinations without rewriting the shell:

| Nav | Near-term | Later |
| --- | --- | --- |
| Destinations | In-page content | Dedicated destination research |
| Honeymoon Planner / Dream Honeymoon | Soft CTA / placeholder | Interactive planner app |
| Shop | Soft CTA / placeholder | Link to `shop.[domain]` Shopify storefront |

## Planned architecture (do not implement until approved)

### 1. Main website (this repo)

- Stay on Cloudflare Pages as the public marketing surface
- Keep the elegant visual system (cream/paper, green, gold, wine; Georgia + clean sans)
- Prefer small, maintainable static (or lightly enhanced) front-end code over a full framework rewrite unless needed

### 2. Interactive honeymoon planner (future)

Backend preference:

- **Cloudflare Workers** for APIs
- **Cloudflare D1** for trip and user data
- Secure authentication (do not invent auth details until requirements exist)

Intended capabilities (requirements TBD; do not invent prior planner behavior):

- Personalized recommendations
- Destination research and comparisons
- Trip budgets and cost estimates
- Day-by-day itineraries
- Saved trips and user accounts
- Booking / reservation outbound links where appropriate

Integration approach: add planner routes or a sibling Worker project and link from the existing nav — avoid rebuilding the marketing site.

### 3. Shopify merchandise store (future)

- Separate Shopify storefront at `shop.[MY DOMAIN].com`
- Linked from the main site’s **Shop** navigation
- Shopify owns checkout, products, payments, and fulfillment
- **Do not** replace this Cloudflare site with a Shopify theme
- **Do not** create a paid Shopify subscription or configure a live store without explicit approval

### Visual consistency

Shared brand tokens should stay aligned across the main site, planner, and Shopify theme (palette, typography, logo lockup, photography style).

## Related references

- Existing business Cloudflare pattern (Workers + assets): `Rj-529/Rj-529-newlywed-pooper-scoopers` — reference only; do not modify.
- Planner prototype concepts may exist elsewhere; wait for original requirements/code before implementing.

## Domain

Custom domain is purchased via Shopify DNS. Point DNS at Cloudflare Pages only after reviewing existing MX/SPF/DKIM and getting approval for changes. Prefer one primary hostname with HTTPS and an appropriate www ↔ apex redirect.

