# The FacetDB plugin registry

A list of FacetDB plugins. `index.json` is the list; it is generated from the files in
`plugins/`, one file per plugin. Nobody edits `index.json` by hand.

## List a plugin

Open a pull request that adds one file, `plugins/<name>.json`, where `<name>` is the short name
people will type in `facetdb add <name>`. The build refuses a file whose name is not the entry's
`name` plus `.json`:

```json
{
  "name": "acme",
  "package": "facetdb-plugin-acme",
  "description": "Send record notifications to Acme.",
  "kinds": ["channel"],
  "facetdb": "^1.0.0",
  "verified": false,
  "homepage": "https://example.com/facetdb-plugin-acme"
}
```

| Field | What it holds |
|---|---|
| `name` | The short name: lowercase letters, digits and dashes, no prefix. Each name is listed once. |
| `package` | The npm package. For the name `acme` it is `facetdb-plugin-acme` (community plugins) or `@facetdb/acme` (the team's own). No other name is accepted. |
| `description` | What the plugin does, in one line of at most 160 characters, with no control characters and no characters that change the direction of the text (it is printed in a terminal). |
| `kinds` | What it provides, from `source`, `action`, `channel`, `provider`, `pack`. At least one, each once. |
| `facetdb` | The range of FacetDB core versions the plugin supports, such as `^1.0.0` or `>=1.2.0 <2.0.0`. |
| `verified` | See below. Leave it `false` in your pull request. |
| `homepage` | Optional. A web address starting with `http://` or `https://`. |

No other field is accepted. The package must be published on npm for `facetdb add` to install it.

## What `verified` means

`verified: true` means the FacetDB team has read the code of the plugin and found nothing that
works against its description. It is not a promise that the plugin is free of bugs, and it
does not make a plugin safe to install without reading it: in the open-source version a plugin
runs inside your worker with the worker's access, so install only plugins you trust.

The flag is set by hand, by the team, in a pull request. The generator never sets it. The mark
covers the plugin as the team reviewed it: later releases of the plugin are not reviewed again.

## Download counts

The `downloads` figure in each listing is npm's count for the package over the last 30 days, read
when the index is generated. FacetDB collects nothing itself. A package that npm does not know
counts 0.

## The index file

`index.json` starts with `format`, the version of the file's layout. It is `1` today. A facetdb
that reads format 1 refuses any other format and says to upgrade facetdb, so a later layout can
add fields without breaking the facetdb that people already run. Within a format, a facetdb
refuses a field it does not know. `generatedAt` is when the index last changed, not when it was
last checked: a build that finds nothing new leaves the file, and so its time, as it was.

## Generate the index

```
pnpm --filter facetdb run registry:build
```

This reads every file in `plugins/`, asks npm for each package's downloads and writes
`index.json`. A file that is not valid stops the build and the message names the file and what
is wrong, so fix that file and run it again. The plugins come out sorted by name, and when
nothing has changed the file is left as it is.
