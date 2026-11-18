# Agent notes: bb-plugin-github-review

bb runs this plugin directly from this checkout, so a local edit can go live
without ever reaching GitHub. Keep GitHub up to date: a change is not finished
until it is committed and pushed.

## After every change

1. Update the docs the change affects: `README.md`, `PLUGIN_OVERVIEW.md` and
   `skills/github-pr-review/SKILL.md`. New settings and command options belong
   in the README and the skill.
2. Run the checks, and add tests for new behaviour:

   ```sh
   npm test
   npm run typecheck
   ```

3. Build and reload, so the running plugin matches the code:

   ```sh
   bb plugin build
   bb plugin reload github-review
   ```

4. Review the diff, then commit and push to `main`:

   ```sh
   git diff
   git add <changed files>
   git commit
   git push origin main
   ```

5. Confirm `git status -sb` shows a clean tree with `main` level with
   `origin/main`.

Don't leave uncommitted work behind. If a change has to stay unfinished, say so
to the user.

## This repo is public

Never commit webhook secrets, tokens, bb project or thread ids, private repo
names, or paths from your machine. Tests use made-up values.

## Layout

- `server.ts`: settings, webhook route, review runs and the `bb github-review` command.
- `webhook.ts`: signature checks and webhook payload parsing.
- `github.ts`: the `gh` and `git` calls.
- `skills/github-pr-review/SKILL.md`: instructions for review threads.
- `dist/`: build output, not committed.
