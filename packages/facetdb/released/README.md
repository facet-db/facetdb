# Released example configs

Each `<version>/<example>/` folder holds the `facetdb.config.ts` that version of the `facetdb`
package shipped as `examples/<example>/facetdb.config.ts`. `scripts/release.sh freeze <version>`
writes a version's folders, named by the bare version (`0.1.0`, `0.1.0-rc.1`, never
`v0.1.0`); nobody copies, edits or formats them by hand.

`src/config/released-configs.test.ts` loads every config here through `loadConfig`, as a user's
project would after upgrading. Each one must load, or be refused with words that say how to fix
it: such a refusal is listed, word for word, in that test's `ACCEPTED_REFUSALS`, so a reviewer
reads it. A name a config imports that facetdb or a plugin no longer exports fails too.

What the test does not judge: a plugin's own settings (a source's, an action's, a channel's) are
judged by the plugin host when a worker starts, and plugin schemas drop keys they do not know, so a
changed plugin setting is not caught; a changed default (`stakes`, `onOutage`, `onCapReached`)
loads and passes too.

Only `facetdb.config.ts` is frozen, so an example's config stays one self-contained file: a config
that imports a file of its own fails here as "does not load".

A release candidate's folder (`<release>-rc.N`) is a rehearsal: the freeze of that release removes
it, and only a release's folder is kept for good. The commit that removes those folders also
removes their entries in `ACCEPTED_REFUSALS`, since the test reports an entry with no config as
stale. Nothing was released before 0.1.0.

This directory is outside `src/` and outside the package's `files`: neither the typecheck, the
build nor the published tarball reads it.
