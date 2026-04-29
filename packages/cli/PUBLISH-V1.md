# Publishing 0.1.2 to npm

### 1) Authenticate

Generate a fresh **Automation** token at <https://www.npmjs.com/settings/~/tokens>,
then in PowerShell:

```powershell
$env:NPM_TOKEN = "npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
"//registry.npmjs.org/:_authToken=$env:NPM_TOKEN" | Out-File -Encoding ascii "$HOME\.npmrc"
npm whoami
```

### 2) Publish 0.1.2

```powershell
cd c:\Users\antar\OneDrive\Documentos\nexseed\agentis\packages\cli
npm publish --access public
```

### 3) Make 0.1.2 the only thing users see

Two options. Pick one.

**A. Deprecate (recommended for public packages)** — keeps the tarballs on
the registry but flags them so `npm install` warns and `npm install
@agentis-ai/cli` picks `latest`:

```powershell
npm dist-tag add @agentis-ai/cli@0.1.2 latest
npm deprecate "@agentis-ai/cli@0.1.0" "Internal pre-release. Use @agentis-ai/cli@latest."
npm deprecate "@agentis-ai/cli@0.1.1" "Internal pre-release. Use @agentis-ai/cli@latest."
```

**B. Unpublish (since 0.1.0/0.1.1 were internal test-only)** — removes the
tarballs entirely. Safe to do *after* 0.1.2 is published (0.1.2 keeps the
name alive, so no 24h blackout):

```powershell
npm unpublish @agentis-ai/cli@0.1.0 --force
npm unpublish @agentis-ai/cli@0.1.1 --force
```

Both 0.1.0 and 0.1.1 are within the 72h unpublish window.

### 4) Verify

```powershell
npm view @agentis-ai/cli versions
npm view @agentis-ai/cli dist-tags
npm install -g @agentis-ai/cli
agentis help
```

### 5) Revoke the token

```powershell
Remove-Item $HOME\.npmrc
Remove-Item Env:NPM_TOKEN
```

Then revoke the token at <https://www.npmjs.com/settings/~/tokens>.
