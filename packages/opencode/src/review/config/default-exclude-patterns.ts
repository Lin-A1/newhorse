// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
//
// Verbatim copy of internal/config/allowlist/default_exclude_patterns.json from
// the open-code-review project. Hosted as a TS array (instead of a `.json`
// import) because the workspace typechecker does not enable `resolveJsonModule`.
//
// Patterns are globs resolved with last-match-wins semantics (a leading `!`
// re-includes a previously excluded path). Supported syntax:
//   - `*`       matches any characters within a single path segment
//   - `**`      matches zero or more path segments (can cross `/`)
//   - `{a,b,c}` brace expansion, matches any one of the items
export const defaultExcludePatterns = [
  "**/*_test.go",
  "**/src/test/java/**/*.java",
  "**/src/test/**/*.kt",
  "**/*.test.{js,jsx,ts,tsx}",
  "**/*.spec.{js,jsx,ts,tsx}",
  "**/__tests__/**",
  "**/test/**/*_test.py",
  "**/tests/**/*_test.py",
  "**/*_test.py",
  "**/*_spec.rb",
  "**/spec/**/*_spec.rb",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*_test.rs",
  "**/oh_modules/**",
  "**/*.test.ets",
  "**/test/**/*.jl",
  "**/test/**/*.hs",
  "**/*Spec.hs",
  "**/test/**/*.lhs",
  "**/*Spec.lhs",
  "**/tests/**/*.nim",
  "**/__snapshots__/**",
  "**/*.snap",
  "**/testdata/**",
  "**/fixtures/**",
  "**/*.generated.*",
  "**/*.gen.go",
  "**/*.pb.go",
  "**/*.pb.cc",
  "**/*.pb.h",
] as const
