// The few GitHub calls the plugin makes itself, through the local `gh` login.
import { execFile } from "node:child_process";

export type CommitState = "pending" | "success" | "failure" | "error";

export interface GitHubClient {
  headSha(repo: string, pr: number): Promise<string>;
  setStatus(
    repo: string,
    sha: string,
    status: { state: CommitState; context: string; description: string; targetUrl: string },
  ): Promise<void>;
}

/** GitHub caps commit status descriptions at 140 characters. */
export function statusDescription(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

export const ghClient: GitHubClient = {
  async headSha(repo, pr) {
    const sha = await gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected head sha for ${repo}#${pr}`);
    return sha;
  },
  async setStatus(repo, sha, { state, context, description, targetUrl }) {
    await gh([
      "api", "-X", "POST", `repos/${repo}/statuses/${sha}`,
      "-f", `state=${state}`,
      "-f", `context=${context}`,
      "-f", `description=${statusDescription(description)}`,
      ...(targetUrl ? ["-f", `target_url=${targetUrl}`] : []),
      "--silent",
    ]);
  },
};
