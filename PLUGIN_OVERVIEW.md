Comment `/bb-review` on a GitHub pull request and bb reviews it.

## What you get

- A webhook endpoint that GitHub calls when someone comments on a PR.
- A bb thread per review, in a fresh worktree of the matching project.
- One review comment posted back to the PR, with 👀 → 👍 reactions on the trigger comment.
- A `bb github-review` command: start a review by hand, list runs, print setup steps.

## How it works

Deliveries are verified with the shared webhook secret (HMAC SHA-256). Only
allowed GitHub users can trigger a review. The agent uses your local `gh`
login to read the PR and post the review, and never approves, merges or pushes.
