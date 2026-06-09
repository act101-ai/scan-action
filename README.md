# act101 online scan action

GitHub Action entrypoint for act101 online.

```yaml
- uses: act101-ai/scan-action@v1
  with:
    oidc-audience: act101-scan
    token-endpoint: https://act101.ai/api/scan/token
    upload-sarif: "true"
    act-channel: beta
```

The action requests a GitHub OIDC token, exchanges it with the act101 Worker,
installs the act CLI release for the selected channel, generates an agent-ready
report artifact, and optionally emits SARIF for GitHub code scanning. PR runs can
also leave inline review comments for line-specific findings when the workflow
grants `pull-requests: write`.

SARIF is a bonus integration. If the repository is private and GitHub code
scanning is not enabled, SARIF upload is skipped and the scan still completes
with `act101-report.md`, `act101-report.html`, and `act101-report.json`
attached to the workflow run.
