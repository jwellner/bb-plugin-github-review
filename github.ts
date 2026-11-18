// The few GitHub calls the plugin makes itself, through the local `gh` login.
import { execFile } from "node:child_process";

export type CommitState = "pending" | "success" | "failure" | "error";

export interface RepoHook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
}

export interface GitHubClient {
  /** `origin` remote URL of the git checkout at `cwd`, or null. */
  gitRemote(cwd: string): Promise<string | null>;
  /** The repo's webhooks; throws without admin access. */
  listHooks(repo: string): Promise<RepoHook[]>;
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

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args[0]} ${args[1] ?? ""}: ${stderr.trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

const gh = (args: string[]) => run("gh", args);

export const ghClient: GitHubClient = {
  async gitRemote(cwd) {
    try {
      return (await run("git", ["-C", cwd, "remote", "get-url", "origin"])) || null;
    } catch {
      return null;
    }
  },
  async listHooks(repo) {
    const out = await gh([
      "api", `repos/${repo}/hooks`,
      "--jq", "[.[] | {id, url: .config.url, events, active}]",
    ]);
    return JSON.parse(out || "[]") as RepoHook[];
  },
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
