# newhorse docs

The newhorse documentation site, built with [Mintlify](https://mintlify.com).

> **Status:** currently scaffolded from the Mintlify starter kit. `index.mdx`,
> `quickstart.mdx`, and the `essentials/` pages are starter content and have not
> been rewritten for newhorse yet.

## Structure

- `docs.json` — Mintlify configuration (theme, navigation, branding)
- `*.mdx` — documentation pages (e.g. `index.mdx`, `quickstart.mdx`, `development.mdx`)
- `ai-tools/` — guides per AI coding tool
- `essentials/` — starter reference pages (markdown, code, navigation, settings)
- `snippets/` — reusable snippets
- `openapi.json` — vendored OpenAPI specification for the SDK reference
- `logo/`, `images/`, `favicon*.svg` — site assets

## Local preview

Install the [Mintlify CLI](https://www.npmjs.com/package/mint):

```bash
npm i -g mint
```

Then run the preview server from this directory (where `docs.json` lives):

```bash
mint dev
```

View the local preview at `http://localhost:3000`.

## Publishing

Changes are deployed automatically through the Mintlify GitHub integration once
they are pushed to the default branch. See the
[Mintlify documentation](https://mintlify.com/docs) for the publishing workflow.
