# bb-plugin-github-review

Review GitHub pull requests with bb by commenting `/bb-review` on them.

```
/bb-review
/bb-review focus on the migration and error handling
```

Marking a draft PR **Ready for review** also starts a review (setting
`reviewOnReadyForReview`; the webhook must send the `pull_request` event).

## Flow

1. GitHub sends the `issue_comment` webhook (or the example Action forwards it) to
   `/api/v1/plugins/github-review/http/webhook`.
2. The plugin checks the `X-Hub-Signature-256` HMAC, the PR, the keyword (it must
   start a line), and that the commenter is in `allowedUsers`. Redeliveries of the
   same comment are ignored.
3. It spawns a thread `Review owner/repo#N` in the bb project whose git remote
   matches the repo, in a fresh managed worktree.
4. The agent follows `skills/github-pr-review/SKILL.md`: it reacts 👀, reads the PR
   with `gh`, reviews it, posts one `gh pr review --comment`, and reacts 👍.

## Setup

```sh
bb plugin install /path/to/bb-plugin-github-review
bb plugin config github-review set webhookSecret "$(openssl rand -hex 32)"
bb plugin config github-review set allowedUsers <your-github-login>
bb github-review setup                  # prints the exact commands below
```

GitHub must be able to reach the webhook path. With Tailscale, Funnel can expose
that one path:

```sh
sudo tailscale funnel --bg --https=8443 \
  --set-path /api/v1/plugins/github-review/http/webhook \
  http://127.0.0.1:<bb-port>/api/v1/plugins/github-review/http/webhook
```

Then add a repo webhook (events `issue_comment` and `pull_request`, content type JSON, the same secret),
or use [`examples/bb-review.yml`](examples/bb-review.yml) as a GitHub Action.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `webhookSecret` | — | Shared HMAC secret (required) |
| `keyword` | `/bb-review` | Comment line prefix that triggers a review |
| `allowedUsers` | — | Comma-separated GitHub logins allowed to trigger reviews (required) |
| `repoProjects` | — | `owner/repo=proj_id` overrides, one per line |
| `reviewOnReadyForReview` | `true` | Review when an allowed user marks a draft ready |
| `commitStatus` | `true` | Show a `bb review` check on the PR: pending → success/failure/error |
| `statusContext` | `bb review` | Name of that check; can be made a required check |
| `postToGitHub` | `true` | Off: review stays in the bb thread |
| `permissionMode` | `auto` | Permission mode for review threads |
| `model` | — | Model for review threads |
| `publicWebhookUrl` | — | Shown by `bb github-review setup` |

## Commands

- `bb github-review review <owner/repo> <pr> [focus…]` starts a review now.
- `bb github-review runs` lists recent runs.
- `bb github-review conclude <run-id> <success|failure> [--url …] [summary]` records
  a review's verdict and updates the PR check. Review threads call this.
- `bb github-review setup` prints the setup steps.

## Develop

```sh
npm install
npm test          # vitest, uses the SDK's fake plugin host
npm run typecheck
bb plugin build
```
