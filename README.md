# act101 online scan action

GitHub Action entrypoint for act101 online.

```yaml
- uses: act101-ai/scan-action@v1
  with:
    oidc-audience: act101-scan
    token-endpoint: https://act101.ai/api/scan/token
    upload-sarif: "true"
```

The action requests a GitHub OIDC token, exchanges it with the act101 Worker,
and emits SARIF for GitHub code scanning.
