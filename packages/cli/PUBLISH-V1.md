# Publishing @agentis-labs/cli

### 1) Authenticate

Generate a fresh **Automation** token at <https://www.npmjs.com/settings/~/tokens>,
then in PowerShell:

```powershell
$env:NPM_TOKEN = "npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
"//registry.npmjs.org/:_authToken=$env:NPM_TOKEN" | Out-File -Encoding ascii "$HOME\.npmrc"
npm whoami
```

### 2) Publish the current package version

```powershell
cd packages\cli
npm publish --access public
```

### 3) Verify

```powershell
npm view @agentis-labs/cli versions
npm view @agentis-labs/cli dist-tags
npx @agentis-labs/cli@latest help
npm install -g @agentis-labs/cli
agentis help
```

### 4) Revoke the token

```powershell
Remove-Item $HOME\.npmrc
Remove-Item Env:NPM_TOKEN
```

Then revoke the token at <https://www.npmjs.com/settings/~/tokens>.
