# Paseo Factory GitHub

GitHub pull request facts for the Paseo Factory: PR state, head, CI, mergeable, draft, review and the merge queue, read through
the daemon's `gh` login and offered on the Factory's PR facts provider registry (`Symbol.for("paseo.pr-facts")`, id `github`).

- No screen, no tools, no settings: it only registers the provider, and removes it when unloaded.
- Without it the Factory reads GitHub itself the same way; with it the Factory's engine holds no GitHub code path.
- A failed read is an error for the Factory to handle; it is not retried through the Factory's own `gh`.
