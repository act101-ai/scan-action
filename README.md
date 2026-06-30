# act101 online scan action

GitHub Action entrypoint for act101 online.

```yaml
permissions:
  contents: read
  id-token: write        # OIDC exchange with the act101 Worker
  pull-requests: write   # sticky/inline PR comments

steps:
  - uses: act101-ai/scan-action@v2
    with:
      oidc-audience: act101-scan
      token-endpoint: https://act101.ai/api/scan/token
```

The action requests a GitHub OIDC token, exchanges it with the act101 Worker,
installs the act CLI release for the selected channel, generates an agent-ready
report artifact, and optionally emits SARIF for GitHub code scanning. PR runs
post a scan comment when the workflow grants `pull-requests: write`.

## Pull request comments

On `pull_request` events the action maintains one sticky comment: it is keyed
by a hidden marker and updated in place on every push, so a PR never collects
one comment per run. The `pr-comment` input controls the behavior — `sticky`
(default), `inline` (the legacy per-finding review comments), or `off`.

On pull requests from forks the `github.token` is read-only regardless of the
workflow's `permissions` block, so the comment cannot be posted; the action
logs a warning and continues, and the scan gate still applies.

When the installed act CLI supports diff-scoped scans (`--base-ref` and
`--format`), the comment reports only what the PR changed, measured against the
committed baseline when `.act/baseline.json` exists, and the check fails when
the scan gate finds new findings. Older CLI releases degrade gracefully: the
action detects the missing capability, posts the full-scan report instead, and
never fails the check for it.

To adopt the baseline workflow, run `act scan --baseline-write` on your default
branch and commit the resulting `.act/baseline.json`. PR scans then surface only
findings introduced relative to that baseline.

The action fetches the PR base ref itself, but a shallow clone can still lack a
merge base, in which case the run falls back to the full-scan report with a
notice. Use `fetch-depth: 0` on `actions/checkout` for reliable diff scoping:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
```

## SARIF

SARIF is a bonus integration and is unchanged by PR comment mode — the sticky
comment is additive. The default path writes the workflow summary and
attaches `act101-report.md`, `act101-report.html`, and `act101-report.json`.
Set `upload-sarif: "true"` when GitHub code scanning is enabled; private
repositories usually need GitHub Advanced Security for that upload path.
