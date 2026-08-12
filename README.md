# Family Office

A read-only-turned-transactional DeFi dashboard. It tracks claimable rewards (fees, bribes, rebases)
across Curve, Aerodrome, Velodrome, Yield Basis, Clever and Concentrator, shows the stablecoins a
wallet already holds, and can execute a full "claim → consolidate to USDC → bridge to crvUSD on
Ethereum mainnet" flow.

Live at **https://nseidm1.github.io/Family-Office/**

## This repo is a publish mirror, not the development repo

The app is developed in a separate **private** repository, along with its task tracker, its
verification tooling (a module-graph check, a headless UI regression suite, a function-selector
derivation tool) and its demo-video recorders. Only the served application is mirrored here, so that
the site can be public while the working notes stay private.

Two consequences worth knowing if you read the source:

- **Some code comments point at files that are not in this repo** — `CLAUDE.md`, `TASKS.md`,
  `tools/verify-ui.mjs`, `tools/dry-run.mjs`, `tools/selector.mjs`. Those live in the private repo.
  The comments are kept **byte-identical** to the originals on purpose: rewriting them here would
  create two versions of the same explanation that drift apart, which is a failure this codebase has
  already been burned by. A dangling filename is a smaller problem than a comment that lies.
- **Do not send pull requests against this repo.** Changes made here would be overwritten by the
  next publish. Open an issue instead.

## Running it locally

There is no build step and there are no dependencies. Any static file server works:

```bash
python3 -m http.server 5173     # then open http://localhost:5173
```

The app reads exclusively from public RPC endpoints for portfolio data, so it renders a fully
interactive demo with no wallet connected at all.

## Notes on what you are looking at

- **No build step, deliberately.** `index.html` loads native ES modules directly; there is no
  bundler, no TypeScript, and no minification. The code is meant to be readable — the comments
  explaining *why* something is done a particular way are the most valuable content here, and
  minifying would both hide them and be trivially reversed.
- **Transaction execution is gated.** `js/core/release.js` holds a `RELEASE_TESTING` flag that
  withholds the final confirmation on real claims while still building the full preview. With no
  wallet connected, the app runs a complete interactive simulation instead, watermarked as such.
- **No funds are ever custodied.** Every transaction is signed by the user's own wallet and sends its
  output directly to the user's own address. There is no backend and no server-side component.
- **`_headers`** is read by header-capable static hosts (Cloudflare Pages, Netlify) to send
  `frame-ancestors`/`X-Frame-Options`, which GitHub Pages cannot set. On GitHub Pages it is inert;
  the in-page defence in `js/framebust.js` is what protects this deployment.

## License

Proprietary, all rights reserved — see [LICENSE](LICENSE). Published to be read and to be used at
this URL, not licensed for reuse.
