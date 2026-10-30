# Paseo Factory GitHub

A [Paseo](https://github.com/getpaseo/paseo) plugin that gives the [Paseo Factory](https://github.com/lerenn/paseo-factory) its
GitHub pull request facts: state, head, CI, mergeable, draft, review decision, and the merge queue (`queued`, `queuePosition`,
`queueEtaSeconds`), plus the diff summary of the run cards. It reads GitHub through the daemon's own `gh` login.

The Factory engine knows no forge. It asks a **PR facts provider** registered on
`globalThis[Symbol.for("paseo.pr-facts")]`: a registry keyed by provider id, each entry
`{ matches(url), prFacts(url), prDiff?(url) }`. This plugin registers the `github` entry when it loads and removes it when it
unloads.

Without this plugin the Factory falls back to the same `gh` reads built into it, so installing or removing the plugin changes
nothing a run sees. The fallback is there for one transition; a later Factory release can drop it once this plugin is installed
everywhere.

## What stays in the Factory

The per-URL facts cache (2 min, merged PRs kept, forced reads for gates) and the merge-wait logic built on the facts:
the merge-queue wait, the left-queue notice (OPS-378), the re-arm of a still-queued wait (decision 9b98fade). They read the
facts whichever source gave them.

## Errors

A `gh` failure is thrown to the Factory, which treats it like its own failed read (facts unavailable in a prompt, a verdict to
retry, a merge wait that polls again). The Factory does not try its built-in fallback behind a failing provider.

## Install

Needs `gh` logged in on the daemon (the same login the Factory uses today) and paseo-factory with the facts-provider registry
(lerenn/paseo-factory, "PR facts provider"). Install the Factory first, then this plugin; the order only matters for which code
reads GitHub, not for what it reads.

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
```

`shared/facts.ts` repeats the Factory's `PrFacts` and `PrFactsProvider` shapes (plugins do not import each other): keep them in
step with paseo-factory `server/blueprints/facts-provider.ts`.
