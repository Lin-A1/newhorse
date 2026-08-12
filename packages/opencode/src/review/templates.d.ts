// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// The review prompt templates are plain markdown text that must reach the LLM
// verbatim. Bun's bundler renders `*.md` imports to HTML; the `?raw` suffix
// preserves the source text, and this declaration types it as a string.

declare module "*.md?raw" {
  const content: string
  export default content
}
