import type { Decision, ExecPolicy, ExecRule, ApprovalRequest } from "@newhorse/schema"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"

/**
 * M4 execpolicy: the tool-layer authorization engine.
 *
 * Model (specs/v2/m4-execpolicy.md):
 *   - `Decision = allow < prompt < forbid`; multiple rules take the strictest
 *     (`max`), and the dangerous-command heuristic is ALWAYS the floor — a rule
 *     can never upgrade a dangerous action to allow.
 *   - Command rules match argv prefix by LONGEST-prefix-first.
 *   - `decide` reads `process.platform` at call time (matching the shell that
 *     `bash.ts` actually invokes) and selects a win32/posix danger table.
 *   - `decidePath` normalizes the raw user path (case-fold on win32, `\`→`/`,
 *     strip leading `./`, relativize absolutes) before matching path rules.
 *   - `approve?` is the single interactive gate. With no approve callback
 *     (DAG / non-interactive SDK), a `prompt` resolves to `forbid` (fail-closed).
 *
 * Everything is data-driven — no if/else chains of per-command logic.
 */

const STRICTNESS: Record<Decision, number> = { allow: 0, prompt: 1, forbid: 2 }

function max(a: Decision, b: Decision): Decision {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b
}

/** Flag: a shell command could not be fully/faithfully tokenized → treat as
 * prompt (fail-closed when no approve callback). */
const UNPARSABLE: Decision = "prompt"

/** Interpreters that can run arbitrary content. If argv[0] is one of these:
 *  - argv[1] is a script path  → script-file execution (prompt)
 *  - argv[1] is a code flag (-c/-e/...) → inline code (prompt)
 *  (specs/v2/m4-execpolicy.md §1 "命令兜底特判"). */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "python", "python3", "node", "nodejs", "php", "bash", "sh", "perl", "py",
  "deno", "bun", "ruby", "powershell", "pwsh", "cscript", "wscript",
  "regsvr32", "mshta", "cmd",
  // Unambiguous arbitrary-code hosts (classic shell exec + scripting engines).
  "awk", "gawk", "mawk", "nawk", "lua", "tclsh",
  // POSIX shell family: `zsh -c`/`fish -c`/`dash -c`/`ksh -c` are `bash -c`
  // equivalents (arbitrary code), so they must not fall to ordinary allow.
  "zsh", "fish", "dash", "ksh", "csh", "tcsh",
])

/** Script file/direct-exec suffixes: a head token shaped like one of these
 * (e.g. `./run.sh`, `.\\run.bat`) runs unvetted content directly — same as
 * "script file execution", so it must not fall to ordinary command allow. */
const EXECUTABLE_SUFFIXES: ReadonlySet<string> = new Set([".sh", ".bash", ".bat", ".cmd", ".ps1"])

/** Code-execution flags: an interpreter followed by one of these is arbitrary
 * inline code (not a script file). */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  "-c", "-e", "-r", "-f", "--eval", "cmd", "command", "-enc", "-encodedcommand",
])

/** Interpreters that ALWAYS take a program (never just a filename with no code):
 * `awk`/`gawk`/`nawk`/`mawk`/`lua`/`tclsh` run their first non-flag arg as
 * program text, so `awk 'BEGIN{system("id")}'` is inline code even without a
 * `-e`/`-c` flag. */
const ALWAYS_PROGRAM: ReadonlySet<string> = new Set(["awk", "gawk", "nawk", "mawk", "lua", "tclsh"])

/** Reduce an interpreter token to its base name so a version suffix or a `.exe`
 * (win32) cannot mask it: `python3.11`→`python3`, `php8.1`→`php`, `node20`→`node`,
 * `ruby3.2`→`ruby`, `perl5.36`→`perl`, `node.exe`→`node`, `command`→`command`.
 * Keeps the major family (`python3` stays `python3`) but drops the minor. */
function interpreterBaseName(token: string): string {
  let t = token.toLowerCase().replace(/\.exe$/, "")
  // Strip a trailing dot-version (`python3.11`→`python3`, `php8.1`→`php`).
  t = t.replace(/^(python|php|node|nodejs|ruby|perl)\d+(\.\d+)*$/, "$1")
  // Strip a trailing bare version digit run (`node20`→`node`, `python39`→`python`).
  t = t.replace(/^(node|nodejs|python|python3|ruby|perl)\d+$/, (m, base) => base)
  return t
}

/** Normalize a SHELL-family name for set membership: strip any version suffix so
 * `bash5.2`/`bash-5.2`/`bash5`/`k sh-2020`/`zsh-5.8` all reduce to `bash`/`ksh`/
 * `zsh`. This is separate from `interpreterBaseName` (which is for the
 * interpreter list) because shells may be hyphen-versioned (`bash-5.2`), which
 * `/^(python|...)\d+/` does not strip. */
function shellBaseName(token: string): string {
  let t = token.toLowerCase()
  // Strip `.exe` (win32), then any leading `-`/`.` + version digit/dot tail.
  t = t.replace(/\.exe$/, "")
  t = t.replace(/-?\d+(\.\d+)*(\.exe)?$/, "")
  return t
}

/** Shell-family names that, when invoked as a command, run arbitrary input via
 * `-c`/stdin. A BOUNDED set (shells are a closed family) — not `*sh`-ends-with
 * matching, which would misclassify `push`/`publish`/`grep-arg` words. Versioned
 * / `.exe` variants (`ksh93`, `bash5.2`, `zsh.exe`) are normalized by the caller. */
const SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "ash", "yash",
  "osh", "mksh", "pdksh", "sash", "cbash", "ksh93", "rush", "nsh", "posh",
  "scsh",
])

/** Is `head` a POSIX/Bourne-family shell (so `-c` is arbitrary code)? Matched
 * against the bounded `SHELL_NAMES` set after normalizing version/dot/`.exe`
 * (`ksh93`→`ksh`, `bash5.2`→`bash`), plus `busybox`/`fish`. NOT an open-ended
 * `*sh` ends-with: `push`/`publish`/`grep sh` are not shells and must not be
 * flagged (a whitelist-of-names for FIXED families is correct — the M4 gap was
 * *interpreter* words behind wrappers, closed by scanning the whole argv, not
 * by over-matching `*sh` words). */
function isShellClass(head: string): boolean {
  if (head === "busybox" || head === "fish") return true
  // Normalize version/dot/`.exe`/hyphen-tail (`ksh93`→`ksh`, `bash5.2`→`bash`,
  // `bash-5.2`→`bash`, `zsh-5.8`→`zsh`).
  const base = shellBaseName(head)
  return SHELL_NAMES.has(base)
}

/** Benign command-prefix words that legitimately precede an interpreter or tool
 * (`nohup python`/`timeout 5 node`/`env python`). The inline-code floor must
 * still fire when the interpreter is behind one of these — otherwise
 * `nohup python -c "..."` rises to allow by moving the interpreter off argv[0]
 * (M2). */
const EXEC_PREFIX_WORDS: ReadonlySet<string> = new Set([
  "nohup", "timeout", "nice", "setsid", "env", "command",
  // Runners that invoke the following command (so an interpreter/shell behind
  // them is still reachable by the forward scan): `watch sh -c id`,
  // `stdbuf -oL sh -c id`.
  "watch", "stdbuf",
  // Namespace / jail / escalation wrappers that run a following command in an
  // altered context — `nsenter -t 1 sh -c id`, `unshare sh -c id`,
  // `chroot / bin/bash -c id`, `proot -r / sh -c id`, `bwrap sh -c id`,
  // `firejail sh -c id`. The shell/interpreter behind them is arbitrary code.
  "nsenter", "unshare", "chroot", "proot", "bwrap", "firejail",
])

const COMMON_DANGEROUS: ReadonlyArray<{ match: RegExp; reason: string }> = [
  // Recursive/force delete via `rm`, in ANY flag order/combination (`rm -rf`,
  // `rm -fr`, `rm -r -f`, `rm -rRf`, `rm --recursive --force`, `rm /x -f`).
  // Lookahead so it need not match the flags contiguously; boundary-protected
  // so `charm`/`rmdir`/`ls -rf` are not flagged.
  { match: /\brm\b(?=[\s\S]*?\s(?:-[rfR]{1,}|--recursive\b|--force\b))/, reason: "recursive force delete" },
  // Windows `del`/`erase` with slash flags (case-insensitive) — same class.
  { match: /\b(?:del|erase)\b[^\n]*?\/[a-z]/i, reason: "recursive force delete (win)" },
  { match: /\bsudo\b/, reason: "privilege escalation" },
  { match: /\bcurl\b[^|]*\|\s*(?:sh|bash)\b/, reason: "pipe remote to shell" },
  { match: />\s*\/dev\/null\b/, reason: "silenced output" },
  { match: /\bkill\s+-9\b/, reason: "force kill" },
  { match: /~\/\.ssh\b/, reason: "ssh key material" },
  { match: /\bchmod\s+777\b/, reason: "world-writable" },
  { match: /\b(curl|wget)\b/, reason: "remote network fetch" },
  { match: /\beval\b|\bsource\b|\bxargs\b/, reason: "shell source control" },
  // `.`(dot) as a standalone command token is the shell `source` builtin
  // (`source /etc/profile`, `. ./payload`, `. ~/.bashrc`, `. "$HOME/x"`) — it
  // runs arbitrary file content. Anchored to command start so it never matches
  // `./foo` (a path), `ls ..` (parent dir), or `echo a`. The sourced path may
  // begin with `/`, `~/`, `"`, `$` — accept any non-space token after a bare
  // `.`. Spec §1/§7 mandate flagging it.
  { match: /^\s*\.\s+(?!\.{1,2}(?:\s|$))(\S+)/, reason: "dot-source control" },
  // `find <path> -delete` and in-place overwrite of a file (`sed -i`) destroy
  // data without a destructive-flag verb.
  { match: /\bfind\b[^|]*\s-delete\b/, reason: "find -delete" },
  { match: /\bsed\s+-i\b/, reason: "in-place overwrite" },
  // `find ... -exec/-execdir/-ok/-okdir <cmd> {} +` runs <cmd> per match —
  // arbitrary code (`find / -exec bash -c 'id' {} +`), even when a shell /
  // interpreter sits behind the action (invisible to argv[0]-only scans). GNU
  // find has exactly four exec-actions; all are code exec. NOTE: `-ok`/`-okdir`
  // prompt on stdin but still run the command per match — and a `< answer.txt`
  // redirect supplies the confirmation, bypassing the separator heuristic.
  { match: /\bfind\b[^|]*-(?:exec|ok)(?:dir)?\s+/, reason: "find exec action" },
  // `env -S "bash -c id"` / `env --split-string "node -e x"` runs the quoted
  // string as a command (a shell/interpreter INSIDE one token, invisible to the
  // forward scan).
  { match: /\benv\s+(?:-S\b|--split-string\b)/, reason: "env -S split command" },
  // `script -c 'cmd'` records a session by RUNNING the given command string;
  // the shell/interpreter is inside one quoted token, invisible to the scan.
  { match: /\bscript\b\s+-\S*c\b/, reason: "script -c runs command" },
  // Privilege-escalation exec wrappers — the non-Linux (`doas`/`pkexec`) and
  // classic (`su -c`) peers of `sudo`: `doas bash -c id` runs arbitrary code as
  // root. Only `sudo` is enumerated today, so gate the whole privesc class.
  { match: /\b(?:sudo|doas|pkexec|setpriv)\b/, reason: "privilege escalation" },
  // Privilege escalation via `su`: `su <user>`, `su -c cmd`, `su -`, or bare `su`
  // (opens a login shell as root). Anchored as a standalone command token
  // (start/space before, space/end after) so it never matches `pursue`/`issue`,
  // a `/su` path component, or a `-su` flag. Any `su`-as-a-command is privesc.
  { match: /(?:^|\s)su(?:\s|$)/, reason: "privilege escalation (su)" },
]

const WIN_SPECIFIC_DANGEROUS: ReadonlyArray<{ match: RegExp; reason: string }> = [
  { match: /\b(?:del|erase)\b[^|]*(\/[fsq]|-f)/i, reason: "force delete" },
  { match: /\b(?:rd|rmdir)\b[^|]*(\/[sq]|-s)/i, reason: "recursive delete" },
  { match: /\bformat\b/i, reason: "disk format" },
  { match: /\breg\s+delete\b/i, reason: "registry delete" },
  { match: /\bicacls\b/i, reason: "acl mutation" },
  { match: /\btaskkill\b[^|]*(\/f|-f)/i, reason: "force kill" },
  { match: /\bnet\s+user\b/i, reason: "account mutation" },
  { match: /\bcertutil\b/i, reason: "cert manipulation" },
  { match: /\bmshta\b/i, reason: "html app exec" },
  { match: /\bwmic\s+process\b/i, reason: "process create" },
  { match: /\b(?:vssadmin|bcdedit)\b/i, reason: "boot config mutation" },
  { match: /\bpowershell(?:\.exe)?\s+(?:-enc(?:odedcommand)?|-e|-c|-E|-ec)\b/i, reason: "encoded/embedded powershell" },
  { match: /\bpwsh(?:\.exe)?\b|\bcscript(?:\.exe)?\b|\bwscript(?:\.exe)?\b|\bregsvr32\b|\bmshta\b/i, reason: "script host exec" },
  { match: /\brundll32\b|\bmsiexec\b|\bforfiles\b/i, reason: "windows lolbin exec" },
]

/** The per-platform danger table. win32 = COMMON ∪ WIN_SPECIFIC (a win32 shell
 * can still run POSIX commands via git-bash/sh -c). */
const DANGEROUS_COMMANDS: Record<"win32" | "posix", ReadonlyArray<{ match: RegExp; reason: string }>> = {
  posix: COMMON_DANGEROUS,
  win32: [...COMMON_DANGEROUS, ...WIN_SPECIFIC_DANGEROUS],
}

/** Command prefixes that must never be auto-allowed by bootstrapping (BANNED_PREFIX). */
const BANNED_PREFIX: ReadonlySet<string> = new Set([
  "bash", "node", "nodejs", "python", "python3", "php", "rm", "sudo", "curl",
  "wget", "sh", "perl", "eval", "source", "xargs", "powershell", "pwsh",
  "cscript", "wscript", "regsvr32", "del", "format", "reg", "icacls", "rd",
  "rmdir", "taskkill", "certutil", "mshta", "rundll32", "msiexec", "forfiles",
])

/** Path suffixes that must never be auto-allowed by bootstrapping (credentials). */
const CREDENTIAL_SUFFIX: ReadonlySet<string> = new Set([".env", ".pem", ".key", ".cert", ".p12", ".crt"])

/** Path rules that must never be auto-allowed by bootstrapping. */
const PROTECTED_PATH_PREFIXES: ReadonlyArray<string> = [".newhorse", ".git"]

const SENSITIVE_PATH_SUFFIXES: ReadonlySet<string> = new Set([".ps1", ".bat", ".cmd", ".pem", ".key", ".crt", ".p12", ".env"])

/** Sensitive path suffixes that are executable script hosts (bootstrappable). */
const SCRIPT_SUFFIXES: ReadonlySet<string> = new Set([".ps1", ".bat", ".cmd"])

/** Curated known-good network hosts that read-type operations may target. */
const KNOWN_HOSTS: ReadonlySet<string> = new Set([
  "github.com", "gitlab.com", "bitbucket.org",
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
  "crates.io", "unpkg.com", "raw.githubusercontent.com",
])

/** Rules-file path: the ONLY host-owned location for user-consented rules. */
export function rulesFilePath(dataDir: string, workspace: string): string {
  const hash = simpleHash(workspace)
  return resolve(dataDir, "projects", hash, "rules.json")
}

/** A simple stable hash (FNV-1a) for a workspace → project rules filename. */
function simpleHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Host-owned rules/dir markers that a model must never reference. */
const BANNED_RULES_PATH: ReadonlyArray<string> = [".newhorse", ".git"]

/** Whether a normalized path segment references a host-owned rules location
 * (the `.newhorse`/`.git` protected prefixes, or the actual rules dir). Applies
 * to any argv/path regardless of write/delete/read. */
function referencesRulesPath(norm: string, rulesDir?: string): boolean {
  // Normalize separators on the input so a win32 argv/path (backslashes) is
  // compared against the forward-slash rulesDir in one reference frame.
  const lower = norm.replace(/\\/g, "/").toLowerCase()
  const segments = lower.split("/")
  if (BANNED_RULES_PATH.some((p) => segments.includes(p) || lower.startsWith(p + "/") || lower === p)) return true
  // The actual host rules dir (e.g. `dataDir/projects/<hash>`): a model must not
  // bash-redirect/write/delete it. Compare normalized segment-suffix so a
  // trailing separator/drive letter doesn't evade it.
  if (rulesDir) {
    const dirSegs = rulesDir.replace(/\\/g, "/").toLowerCase().split("/").filter(Boolean)
    const tail = dirSegs.slice(-3).join("/")
    if (tail && segments.join("/").includes(tail)) return true
  }
  return false
}

interface EngineOptions {
  /** Host-owned rules file path. Consented rules are persisted here. */
  readonly rulesFile: string
  /** User rules from config (execRules); merged above dangerous floor. */
  readonly rules?: readonly ExecRule[]
  /** The rules-file's directory: a model must never touch it via bash or path.
   * Defaults to `dirname(rulesFile)`. */
  readonly rulesDir?: string
  /** Interactive gate. Absent → prompt resolves to forbid (fail-closed). */
  readonly onApprove?: (req: ApprovalRequest) => Promise<boolean>
  /** Append a Session.ExecDecision audit entry for a prompt/forbid action. */
  readonly audit?: (entry: { kind: "command" | "path"; action: string; decision: "prompt" | "forbid"; reason?: string; requestId?: string }) => Promise<void>
}

/** The engine's mutable (via bootstrap) rule set + cached load. */
interface EngineState {
  /** Loaded user rules (discriminated); bootstrapped rules appended. */
  rules: ExecRule[]
  /** version bumped on bootstrap so a concurrent decide re-reads. */
  version: number
}

/**
 * Create a rich ExecPolicy. `decide`/`decidePath` are pure functions over the
 * engine state (rules are loaded once and re-read on version change); bootstrap
 * writes back atomically and bumps the version.
 */
export function createExecPolicy(opts: EngineOptions): ExecPolicy {
  const state: EngineState = { rules: [...(opts.rules ?? [])], version: 0 }
  const rulesDir = opts.rulesDir ?? dirname(opts.rulesFile)

  // Load consented rules once (fail-closed on a poisoned file).
  const load = async (): Promise<void> => {
    try {
      const raw = await readFile(opts.rulesFile, "utf8")
      const parsed = JSON.parse(raw) as { rules?: ExecRule[] }
      if (!Array.isArray(parsed.rules)) return
      // Validate: drop rules that contain poisoned/BANNED content; fail-closed
      // (keep file rules) but never let a poisoned rule upgrade a danger.
      const clean = parsed.rules.filter(isTrustedRule)
      state.rules = [...(opts.rules ?? []), ...clean]
      state.version += 1
    } catch {
      // No rules file yet, or unreadable — start with user rules only (fail-closed
      // defaults are already the floor).
      state.rules = [...(opts.rules ?? [])]
    }
  }
  void load()

  const decideRaw = (cmd: string): Decision => {
    const argv = tokenize(cmd)
    // Defense #1 (BANNED_RULES_PATH): any argv referencing the host rules dir /
    // protected prefixes is forbid, regardless of write/delete/read.
    if (argv.some((a) => referencesRulesPath(a, rulesDir))) {
      void emitAudit({ kind: "command", action: cmd, decision: "forbid", reason: "banned rules path" })
      return "forbid"
    }
    const ruleDecision = matchRules(state.rules, argv)
    const heuristicDecision = heuristicCommand(cmd, argv)
    const decision = max(ruleDecision, heuristicDecision.decision)
    // Audit the interception (M4 #12): a prompt/forbid action is observable via
    // the durable log. Only intercepted (non-allow) actions are recorded; an
    // allow is the default and is not noise. Fire-and-forget — the decision is
    // already made, the audit is best-effort observability.
    if (decision !== "allow") void emitAudit({ kind: "command", action: cmd, decision, reason: heuristicDecision.reason })
    return decision
  }

  const decidePath = (rawPath: string): Decision => {
    const norm = normalizePath(rawPath)
    // Defense #1 + #2: the host rules file/dir and `read`-protected paths are
    // forbid regardless of shape.
    if (referencesRulesPath(norm, rulesDir)) {
      void emitAudit({ kind: "path", action: rawPath, decision: "forbid", reason: "banned rules path" })
      return "forbid"
    }
    const ruleDecision = matchPathRules(state.rules, norm)
    const heuristicDecision = heuristicPath(norm)
    const decision = max(ruleDecision, heuristicDecision.decision)
    if (decision !== "allow") void emitAudit({ kind: "path", action: rawPath, decision, reason: heuristicDecision.reason })
    return decision
  }

  /** Wire the audit hook so a prompt/forbid decision is observable (M4). */
  const emitAudit = (entry: { kind: "command" | "path"; action: string; decision: "prompt" | "forbid"; reason?: string }): Promise<void> =>
    opts.audit?.(entry) ?? Promise.resolve()

  // The interactive gate is exposed as-is; the tool-side consumer
  // (`common.ts approve`) applies the single 30s fail-closed timeout. Wrapping
  // here too would double-timeout and leave a dangling prompt after a denial.
  const approve = opts.onApprove

  return {
    decide: (cmd) => decideRaw(cmd),
    decidePath: (path) => decidePath(path),
    approve,
  }
}

/**
 * The full ExecPolicy assembly used by the runtime: it layers consented rules
 * (already loaded via createExecPolicy), provides the approve gate, and wires
 * bootstrap write-back + audit. Returns the policy the tools consume.
 */
export function createBuiltinExecPolicy(opts: {
  readonly dataDir: string
  readonly workspace: string
  readonly rules?: readonly ExecRule[]
  readonly onApprove?: (req: ApprovalRequest) => Promise<boolean>
  readonly audit?: (entry: { kind: "command" | "path"; action: string; decision: "prompt" | "forbid"; reason?: string; requestId?: string }) => Promise<void>
}): ExecPolicy {
  const rulesFile = rulesFilePath(opts.dataDir, opts.workspace)
  const engine = createExecPolicy({
    rulesFile,
    rules: opts.rules,
    rulesDir: dirname(rulesFile),
    onApprove: opts.onApprove,
    audit: opts.audit,
  })
  return engine
}

/* ---------------------------------------------------------------------------
 * Decision decomposition
 * ------------------------------------------------------------------------- */

/** Build an argv array from a raw shell command string (lightweight tokenizer).
 * Marks interactions that make faithful parsing impossible by returning tokens
 * that still feed prefix matching, while heuristicCommand separately flags
 * unparsable constructs. */
function tokenize(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let i = 0
  let list = false
  for (const ch of cmd) {
    if (ch === "'" || ch === '"') {
      // Inside quotes: no splitting, no escaping. Content is literal.
      list = !list
      continue
    }
    if (!list && (ch === " " || ch === "\t" || ch === "\n")) {
      if (cur.length > 0) out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/**
 * True if the command contains constructs that make faithfully parsing which
 * sub-commands run unreliable → treat as unparsable (fail-closed prompt).
 * This is the win32 + posix aware guard.
 */
function isUnparsable(cmd: string): boolean {
  // Process substitution / command substitution / variable expansion that
  // changes which commands actually run (posix). A bare `$` (e.g. `echo $HOME`)
  // is ordinary expansion, NOT a control-source — leave it alone (SHOULD-FIX S2).
  if (cmd.includes("$(") || cmd.includes("`") || cmd.includes("${")) return true
  // Backslash escaping a space/`;` changes token boundaries → unparsable (posix).
  // On win32 `\` is a plain path separator (`dir C:\Users`) — NOT an escape
  // (cmd escapes with `^`), so it must not demote win32 path commands.
  if (process.platform !== "win32" && cmd.includes("\\")) return true
  // Shell separators: `|`, `;`, `&&`, `||`, `&` mean MORE THAN ONE command runs
  // (in both posix and cmd). The RHS / a later command can be an interpreter or
  // shell (`echo 'id' | sh`, `cat x | python -c ...`) that argv[0]-only scans
  // never see → arbitrary code, fail-closed.
  if (cmd.includes("|") || cmd.includes(";") || cmd.includes("&")) return true
  // Windows cmd: delayed expansion, caret continuation, %VAR%.
  if (process.platform === "win32") {
    if (cmd.includes("%") || cmd.includes("^")) return true
  }
  // Control-source tokens (all platforms) — `eval`/`source`/`.`-source/`xargs`
  // can run arbitrary sub-commands and are hard to parse faithfully.
  if (/\beval\b|\bsource\b|\bxargs\b/.test(cmd)) return true
  return false
}

/** The rule match for a command argv, LONGEST-prefix-first. */
function matchRules(rules: ExecRule[], argv: string[]): Decision {
  let best: Decision = "allow"
  let bestLen = -1
  for (const rule of rules) {
    if (rule.type !== "prefix_rule") continue
    if (argv.length < rule.pattern.length) continue
    let ok = true
    for (let i = 0; i < rule.pattern.length; i++) {
      if (argv[i] !== rule.pattern[i]) { ok = false; break }
    }
    if (!ok) continue
    if (rule.pattern.length > bestLen) {
      bestLen = rule.pattern.length
      best = rule.decision
    } else if (rule.pattern.length === bestLen) {
      best = max(best, rule.decision)
    }
  }
  // network_rule: host/protocol check. If the first token is a network tool and
  // a host is present, apply the matching network_rule (or the known-host
  // default). Explicitly consult the loaded rules so a user-declared
  // network_rule forbid is honored, not just the known-host allowlist (M1).
  const networkDecision = matchNetwork(rules, argv)
  return max(best, networkDecision)
}

function matchNetwork(rules: ExecRule[], argv: string[]): Decision {
  const networkTools: ReadonlySet<string> = new Set(["git", "curl", "wget", "ssh", "rsync", "scp"])
  if (argv.length === 0 || !networkTools.has(String(argv[0] as string).toLowerCase())) return "allow"
  // Extract a host from the argv (a URL, a refspec, or `host:`).
  const joined = argv.join(" ")
  const host = extractHost(joined)
  // A network_rule that names this specific host+protocol wins (most specific).
  // Protocol defaults to http when a rule omits it in matching (a git refspec
  // carries no scheme); we match on host only, the more permissive axis, so a
  // forbid on `github.com` gates both http and https.
  const protocol = joined.includes("https://") ? "https" : joined.includes("http://") ? "http" : "https"
  let best: Decision = "allow"
  for (const rule of rules) {
    if (rule.type !== "network_rule") continue
    if (rule.host.toLowerCase() !== host?.toLowerCase()) continue
    if (rule.protocol !== protocol) continue
    best = max(best, rule.decision)
  }
  if (host !== undefined) {
    if (best === "forbid") return "forbid"
    if (best === "prompt") return "prompt"
  }
  // No resolvable host → nothing to gate (a bare `git` with no url falls through
  // to prefix rules). No network_rule matched → known-host allowlist, else prompt.
  if (host === undefined) return "allow"
  return KNOWN_HOSTS.has(host.toLowerCase()) ? "allow" : "prompt"
}

function extractHost(joined: string): string | undefined {
  const urlMatch = joined.match(/(?:https?:\/\/|\bssh:\/\/|\bgit@|\b(?:[a-z0-9._-]+)@)([^/\s:]+)/i)
  if (urlMatch) return urlMatch[1]!
  // An explicit `host:path` scp-style refspec (e.g. `prod:/var/www`,
  // `server:/repo`), matched ONLY as a bare `host:` token preceded by a
  // boundary — never a single-dash / double-dash flag (`-q`, `--oneline`),
  // which `git log --oneline` passes in and must not be read as a "host".
  const hostMatch = joined.match(/(?:^|\s)([a-z0-9][a-z0-9._-]*):(?:\/|$)/i)
  if (hostMatch) return hostMatch[1]!
  return undefined
}

/** Path rule match on a normalized path. */
function matchPathRules(rules: ExecRule[], norm: string): Decision {
  let best: Decision = "allow"
  for (const rule of rules) {
    if (rule.type !== "path_rule") continue
    if (globPrefixMatch(rule.prefix, norm)) best = max(best, rule.decision)
  }
  return best
}

/** Match a path_rule prefix (glob-ish) against a normalized path. */
function globPrefixMatch(pattern: string, norm: string): boolean {
  const p = pattern.replace(/^\.\//, "").toLowerCase()
  const n = norm.toLowerCase()
  if (p.startsWith("**/")) return n.includes(p.slice(3)) || n.startsWith(p.slice(3))
  if (p.startsWith("*.")) return n.endsWith(p.slice(1))
  return n.startsWith(p)
}

/** The dangerous-command heuristic floor (data-driven). Returns the strictest
 * decision signalled by any matching danger pattern, plus the reason of the
 * most-constraining hit (for audit). */
function heuristicCommand(cmd: string, argv: string[]): { decision: Decision; reason?: string } {
  let d: Decision = "allow"
  let reason: string | undefined
  // 1. Script-file / inline-code interpreter specials (never allow).
  const interpDecision = interpreterSpecial(argv)
  if (interpDecision !== "allow") { d = max(d, interpDecision); reason = "interpreter special" }
  // 2. Unparsable shell control → prompt (fail-closed).
  if (isUnparsable(cmd)) { d = max(d, UNPARSABLE); reason = "unparsable shell control" }
  // 3. Data-driven danger patterns (platform table).
  const table = DANGEROUS_COMMANDS[process.platform === "win32" ? "win32" : "posix"]
  for (const { match, reason: r } of table) {
    if (match.test(cmd)) { d = max(d, "prompt"); reason = r; break }
  }
  return { decision: d, reason }
}

/** The script-file / inline-code interpreter special: the command runs an
 * interpreter (a) with a code flag after it, or (b) a script path → prompt.
 * The interpreter may sit behind wrapper plumbing (`nohup python`, `timeout 5
 * node`, `env -i python`, `env foo=bar node`, `-- python`) OR behind an
 * un-enumerated "run-a-following-command" wrapper (`taskset bash -c id`,
 * `runuser -u root -- bash -c id`, `setarch bash -c id`, `chroot / bin/bash`),
 * so we scan the WHOLE argv for a shell-class / interpreter token rather than
 * only checking argv[0] — otherwise the floor is bypassed by masking the
 * interpreter off the head (M2/M4). Scanning all tokens (past any wrapper word)
 * closes the wrapper-name enumeration hole: any shell/interpreter anywhere is
 * arbitrary code. */
function interpreterSpecial(argv: string[]): Decision {
  if (argv.length === 0) return "allow"
  // Index of the first BARE command word (the exec head): wrapper words before
  // it (`taskset`/`runuser`/`chroot`/`env`/`nice`/...) are plumbing.
  const headIndex = (() => { let h = 0; while (h < argv.length && isPlumbingToken(String(argv[h] as string))) h++; return h })()
  // Direct script-file execution: the exec head IS an executable path
  // (`./run.sh`, `.\\run.bat`, `build/deploy.sh`) — content unvetted, same as
  // "script file execution". Never falls to ordinary command allow. Only the
  // head is checked, so `find / -name x` (the `/` is a path ARG, not a script)
  // is not over-blocked.
  if (headIndex < argv.length && isExecutablePath(String(argv[headIndex] as string))) return "prompt"
  // Index of the first BARE command word (the exec head): wrapper words before
  // it (`taskset`/`runuser`/`chroot`/`env`/`nice`/...) are plumbing. If the head
  // is a shell/interpreter, or a shell/interpreter sits after it with a code
  // flag / script path, it is arbitrary code.
  // Scan every token for a shell-class or interpreter name. A filename/path arg
  // (`cat x.py`, `grep foo.sh`, `./build.sh`) is NOT an exec head and is skipped
  // unless it is a versioned INTERPRETER name (`python3.11` is a head, not a
  // file). `busybox` is a multi-call binary (not a shell) — ignore it as a token;
  // its subcommand (`sh`/`awk`) is caught by this same scan.
  for (let k = 0; k < argv.length; k++) {
    const raw = String(argv[k] as string)
    const token = interpreterBaseName(raw)
    const isShell = isShellClass(token)
    const isRun = INTERPRETERS.has(token) || isShell
    if (token === "busybox") continue
    // A quoted sub-command collapses to ONE token (`ssh host 'sh -c id'` →
    // ["ssh","host","sh -c id"]): the shell + code flag are hidden inside it and
    // the whole-argv scan never sees them — a remote/shell-host escape (the
    // unquoted `ssh host bash -c id` IS caught). If the token holds whitespace
    // it is a command string, so re-run the scan on its split sublist.
    if (!isRun && /\s/.test(raw)) {
      const nested = interpreterSpecial(raw.split(/\s+/))
      if (nested !== "allow") return nested
    }
    if (!isRun) continue
    // A filename/path arg (`cat x.py`, `grep foo.sh`) is NOT an exec head — skip
    // it — UNLESS the token is an interpreter or a shell family name. A
    // VERSIONED shell/interpreter (`bash5.2`, `python3.11`) is a head, not a
    // file; only a shellBaseName that resolves to a REAL shell is a head.
    if (isPathLike(raw) && !INTERPRETERS.has(token) && !isShell) continue
    const next = k + 1 < argv.length ? interpreterBaseName(String(argv[k + 1] as string)) : ""
    const nextShell = next ? isShellClass(next) : false
    // (a) The exec head is a shell/interpreter → arbitrary (REPL/stdin/-c).
    if (k <= headIndex) return "prompt"
    // (b) A code flag / a script path / another interpreter / a shell follows.
    //     A shell accepts ANY number of transparent `-s`/`-l`/`--login`/`--`
    //     (boolean, repeatable, operand-free) before `-c`, so a fixed window is
    //     evadable (`bash -s -s -l -c id` pushes `-c` past k+3). Scan the FULL
    //     argv tail — a code-vector ANYWHERE after a shell/interpreter token is
    //     arbitrary code. Only transparent markers (`--`, an operand-free shell
    //     flag, or a path arg) do not by themselves trigger; a real code flag /
    //     script-path / redirect / interpreter anywhere in the tail does.
    for (let j = k + 1; j < argv.length; j++) {
      const v = interpreterBaseName(String(argv[j] as string))
      if (INLINE_CODE_FLAGS.has(v)) return "prompt"
      if (INTERPRETERS.has(v) || isShellClass(v)) return "prompt"
      if (v && /[./\\]/.test(v)) return "prompt" // script path arg
      if (/^<{1,3}-?$/.test(String(argv[j] as string))) return "prompt" // stdin redirect / heredoc
    }
    // (c) An always-runs-a-program interpreter with a bare program arg.
    if (ALWAYS_PROGRAM.has(token) && k + 1 < argv.length) return "prompt"
  }
  return "allow"
}

/** Does this token have a path/filename shape (contains a path separator, a
 * leading `./`/`.\\`/`/`, or a file extension)? Used to skip args in the whole-
 * argv scan so `grep foo.sh`/`file bash`/`cat x.py` are not misread as an exec
 * head (exec heads are BARE command names). Absolute paths are path-like. */
function isPathLike(token: string): boolean {
  const lower = token.toLowerCase()
  if (lower.includes("/") || lower.includes("\\")) return true
  if (lower.startsWith(".")) return true // .hidden, ./, .\ ...
  // A trailing extension (`.sh`, `.py`, `.bash`, `.txt`, ...) marks a filename.
  const dot = lower.lastIndexOf(".")
  if (dot > 0) return true
  return false
}

/** Is this token a direct executable script path (`./run.sh`, `.\\run.bat`,
 * `build/deploy.sh`)? A leading `./`/`.\`/absolute or a recognized script
 * suffix marks it as direct execution, not a plain command name. */
function isExecutablePath(token: string): boolean {
  const lower = token.toLowerCase()
  if (lower.startsWith("./") || lower.startsWith(".\\") || lower.includes("/") || lower.includes("\\")) {
    return true
  }
  const dot = lower.lastIndexOf(".")
  const ext = dot >= 0 ? lower.slice(dot) : ""
  return EXECUTABLE_SUFFIXES.has(ext)
}

/** Is this argv token wrapper plumbing (not the exec head)? Covers prefix words
 * (`nohup`/`timeout`/`nice`/`setsid`/`env`/`command`), numeric args (`timeout
 * 5`), `env` assignments (`foo=bar`), flag tokens (`-i`, `-n`, `-v`, `--`,
 * `--long`), so the interpreter behind them is still found. */
function isPlumbingToken(token: string): boolean {
  const lower = token.toLowerCase()
  if (EXEC_PREFIX_WORDS.has(lower)) return true
  if (/^\d+$/.test(token)) return true
  if (/^[a-z_][a-z0-9_]*=/i.test(token)) return true // env assignment
  if (/^-/.test(token)) return true // flag / `--` end-of-options
  return false
}

/** Path danger floor. Returns the strictest decision + reason (for audit). */
function heuristicPath(norm: string): { decision: Decision; reason?: string } {
  const lower = norm.toLowerCase()
  // Protected paths (rules + git) are always forbidden, as any path segment —
  // a model must not be able to write `.newhorse/**` by disguising it as a
  // deeper path (`a/.newhorse/x`). The path_rule in the engine is normalized the
  // same way.
  const segments = lower.split("/")
  if (PROTECTED_PATH_PREFIXES.some((p) => segments.includes(p) || lower.startsWith(p + "/") || lower === p)) return { decision: "forbid", reason: "protected path" }
  // Sensitive suffixes → prompt.
  const base = basename(lower)
  const dot = base.lastIndexOf(".")
  const ext = dot >= 0 ? base.slice(dot) : ""
  if (SENSITIVE_PATH_SUFFIXES.has(ext)) return { decision: "prompt", reason: "sensitive path suffix" }
  return { decision: "allow" }
}

/* ---------------------------------------------------------------------------
 * Path normalization (B2) — single reference frame for decidePath
 * ------------------------------------------------------------------------- */
function normalizePath(raw: string): string {
  let p = raw.replace(/\\/g, "/").replace(/^\.\//, "")
  if (process.platform === "win32") p = p.toLowerCase()
  // Relativize absolute paths against cwd/workspace is the caller's job; here we
  // just strip a leading drive/root so a bare absolute still matches rules.
  const abs = isAbsolute(raw)
  if (abs) p = stripAbsolute(p)
  return p
}

function stripAbsolute(p: string): string {
  const parts = p.split("/")
  // Trim leading empty segment(s) and a possible drive letter.
  const nonEmpty = parts.filter((s) => s.length > 0 && !/^[a-z]:$/i.test(s))
  return nonEmpty.join("/")
}

/* ---------------------------------------------------------------------------
 * Bootstrap write-back (allowed prefixes only, credentials excluded)
 * ------------------------------------------------------------------------- */
export async function bootstrapAppend(
  opts: {
    readonly rulesFile: string
    readonly rule: ExecRule
    readonly rules: readonly ExecRule[]
  },
): Promise<void> {
  // Never bootstrap a BANNED / credential / protected rule.
  if (!isTrustedRule(opts.rule)) return
  const next = [...opts.rules, opts.rule]
  // Atomic write: tmp + rename.
  const tmp = `${opts.rulesFile}.tmp`
  await mkdir(dirname(opts.rulesFile), { recursive: true })
  await writeFile(tmp, JSON.stringify({ rules: next }, null, 2), "utf8")
  await rename(tmp, opts.rulesFile)
}

/** A rule is "trusted" for bootstrap if it doesn't name a BANNED/credential/
 * protected target. This both gates self-bootstrap and fails-closed a poisoned
 * rules file on load. */
function isTrustedRule(rule: ExecRule): boolean {
  if (rule.type === "prefix_rule") {
    const head = String(rule.pattern[0] ?? "").toLowerCase()
    if (BANNED_PREFIX.has(head)) return false
  }
  if (rule.type === "path_rule") {
    const base = basename(rule.prefix.replace(/[*.\\]/g, "/").toLowerCase())
    const dot = base.lastIndexOf(".")
    const ext = dot >= 0 ? base.slice(dot) : ""
    if (CREDENTIAL_SUFFIX.has(ext)) return false
    if (PROTECTED_PATH_PREFIXES.some((p) => rule.prefix.toLowerCase().includes(p))) return false
  }
  return true
}

/** Export for tests. */
export { max as _testMax, normalizePath as _testNormalizePath, interpreterSpecial as _testInterpreterSpecial }
