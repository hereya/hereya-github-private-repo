# hereya/github-private-repo

Creates a private GitHub repository from a public GitHub Template repo, edits `hereya.yaml` (and optionally `hereyaconfig/hereyavars/*` and `CLAUDE.md` placeholders) inside the new repo, and emits the `hereyaGit*` outputs that `hereya clone` consumes.

Authentication is via a workspace-level **GitHub App**, so the credentials are scoped to the org/user where private repos are created and the installation token issued at clone time is bound to that App's permissions.

## Inputs

Read from `process.env` at provision time. Workspace-level values are set once via `hereya env add`; per-project values come from `hereya init` parameters.

| Var | Source | Required | Description |
| --- | --- | --- | --- |
| `projectName` | hereya init | yes | Project identifier; also the default for `targetRepo` (must be `org/name`). |
| `workspace` | hereya init | yes | Workspace name. Written into `hereya.yaml` of the new repo. |
| `sourceTemplate` | parameter | yes | Public GitHub Template repo, in `org/name` form (e.g. `hereya/lambda-mcp-starter`). |
| `targetRepo` | parameter | no (default `projectName`) | Target private repo, in `org/name` form. |
| `hereyaGithubAppId` | workspace env | yes | GitHub App ID. |
| `hereyaGithubAppInstallationId` | workspace env | yes | Installation ID of the App on the target org/user. |
| `hereyaGithubAppPrivateKey` | workspace env | yes | App private key (PEM). Stored sensitive in AWS Secrets Manager via `hereya env add --sensitive`. |
| `deployWorkspace` | parameter | no | Substituted for `{{deployWorkspace}}` in `CLAUDE.md` of the new repo. |
| `hereyaVarsJson` | parameter | no | JSON object mapping `hereyaconfig/hereyavars/<filename>` to the YAML body to write. |

## Outputs

| Output | Value |
| --- | --- |
| `hereyaGitRemoteUrl` | `https://github.com/<targetRepo>.git` |
| `hereyaGitUsername` | `x-access-token` |
| `hereyaGitPassword` | ARN of an AWS Secrets Manager secret whose value is the literal `github-app:<installationId>` marker |

The hereya-cli credential helper resolves the marker into a fresh GitHub App installation token on every git operation (clone / pull / push), so tokens are always within their TTL and bound to that specific repo via the App's installation scope.

## One-time workspace setup

You need a GitHub App installed on the target org/user. The App is workspace-scoped (one per workspace), not per-project, so this is a one-time setup.

1. Create a GitHub App on the target org or user account. Required permissions:
   - `Administration: Read & Write` (creates repos)
   - `Contents: Read & Write` (commit and push)
   - `Metadata: Read`
   - Subscribe to no events.
2. Install the App on the same org/user. After install, note the **Installation ID** (visible in the install URL: `https://github.com/.../installations/<id>`).
3. Generate and download the App's private key (`.pem`).
4. From inside the workspace where you intend to run `hereya init`, set the workspace env:

   ```bash
   hereya env add hereyaGithubAppId <appId>
   hereya env add hereyaGithubAppInstallationId <installationId>
   hereya env add --sensitive hereyaGithubAppPrivateKey "$(cat private-key.pem)"
   ```

These are workspace-level — every `hereya init` against `hereya/github-private-repo` in this workspace re-uses them.

## Usage

```bash
hereya init <org>/my-app \
  --template hereya/github-private-repo \
  --parameter sourceTemplate=hereya/lambda-mcp-starter
```

This creates `https://github.com/<org>/my-app` (private) from `hereya/lambda-mcp-starter`, appends `project: <org>/my-app` and `workspace: <ws>` to the new repo's `hereya.yaml`, and clones it locally with the credential helper wired up.

To seed `hereyaconfig/hereyavars/*.yaml`:

```bash
hereya init <org>/my-app \
  --template hereya/github-private-repo \
  --parameter sourceTemplate=hereya/lambda-mcp-starter \
  --parameter "hereyaVarsJson=$(jq -c '.' < my-vars.json)"
```

where `my-vars.json` is e.g.

```json
{
  "hereya--aws-mcp-app-lambda.yaml": "---\nprofile: dev\ncustomDomain: foo\n---\nprofile: production\ncustomDomain: foo\n"
}
```

## Notes

- On `Delete`, the stack does not delete the GitHub repo. This preserves user code; clean up manually if needed.
- The `Create` path is idempotent: if the repo already exists (e.g. you re-run `hereya init`), it skips repo creation and only re-applies the file edits.
- The Lambda handler retries reading `hereya.yaml` post-create, since GitHub may not surface the file from a freshly templated repo immediately.
