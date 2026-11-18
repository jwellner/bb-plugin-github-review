import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "./github";
import { createPlugin } from "./server";
import { REVIEW_MARKER, extractFocus, repoFromRemote, sign } from "./webhook";

const SECRET = "test-secret";

function commentPayload(overrides: { body?: string; login?: string; pr?: boolean; id?: number } = {}) {
  return {
    action: "created",
    issue: { number: 7, ...(overrides.pr === false ? {} : { pull_request: { url: "x" } }) },
    comment: {
      id: overrides.id ?? 1001,
      body: overrides.body ?? "/bb-review focus on auth",
      html_url: "https://github.com/jwellner/website/pull/7#issuecomment-1001",
      user: { login: overrides.login ?? "jwellner" },
    },
    repository: { full_name: "jwellner/website" },
  };
}

async function setup(
  settings: Record<string, string | boolean> = { webhookSecret: SECRET, allowedUsers: "jwellner" },
  hooks: () => Promise<{ id: number; url: string; events: string[]; active: boolean }[]> = async () => [],
) {
  let spawned = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "github-review",
    settings,
    sdk: {
      projects: {
        defaultExecutionOptions: async () => ({ providerId: String(settings.projectProvider ?? "claude-code") }),
        list: async () => [{ id: "proj_web", gitRemoteUrl: "git@github.com:jwellner/website.git", sources: [{ hostId: "host_1", isDefault: true }] }],
      },
      threads: { spawn: async () => ({ id: `thr_${++spawned}` }) },
      providers: {
        list: async () => [
          { id: "claude-code", capabilities: { permissionModes: ["accept-edits", "auto", "full"] } },
          { id: "acp-cursor", capabilities: { permissionModes: ["accept-edits", "full"] } },
        ],
      },
    } as never,
  });
  const statuses: { repo: string; sha: string; state: string; context: string; description: string; targetUrl: string }[] = [];
  const github: GitHubClient = {
    gitRemote: async (cwd) => (cwd === "/work/website" ? "git@github.com:jwellner/website.git" : null),
    listHooks: hooks,
    headSha: async () => "a".repeat(40),
    setStatus: async (repo, sha, status) => void statuses.push({ repo, sha, ...status }),
  };
  await createPlugin(bb, github);
  const post = (payload: unknown, opts: { event?: string; signature?: string; delivery?: string } = {}) => {
    const body = JSON.stringify(payload);
    return harness.behavior.fetchHttp("POST", "/webhook", {
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": opts.event ?? "issue_comment",
        "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
        "x-hub-signature-256": opts.signature ?? sign(SECRET, body),
      },
    });
  };
  const spawnCalls = () => harness.inspection.sdk.callsTo("threads.spawn");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { harness, post, spawnCalls, settle, statuses };
}

describe("webhook", () => {
  it("starts a review for a signed /bb-review comment", async () => {
    const { post, spawnCalls, settle, harness } = await setup();
    const res = await post(commentPayload());
    expect(res.status).toBe(202);
    await settle();
    expect(spawnCalls()).toHaveLength(1);
    const args = spawnCalls()[0]![0] as { projectId: string; title: string; prompt: string };
    expect(args.projectId).toBe("proj_web");
    expect((args as unknown as { environment: { hostId?: string } }).environment.hostId).toBe("host_1");
    expect(args.title).toBe("Review jwellner/website#7");
    expect(args.prompt).toContain("focus on auth");
    const runs = await harness.behavior.runCli(["runs", "--json"]);
    expect(JSON.parse(runs.stdout ?? "[]")[0]).toMatchObject({ status: "running", thread_id: "thr_1" });
  });

  it("rejects a bad signature", async () => {
    const { post, spawnCalls } = await setup();
    const res = await post(commentPayload(), { signature: sign("wrong", "{}") });
    expect(res.status).toBe(401);
    expect(spawnCalls()).toHaveLength(0);
  });

  it.each([
    ["non-PR issue comment", commentPayload({ pr: false })],
    ["no keyword", commentPayload({ body: "looks good" })],
    ["keyword mid-sentence", commentPayload({ body: "ping /bb-review later" })],
    ["disallowed user", commentPayload({ login: "stranger" })],
    ["the bot's own review", commentPayload({ body: `${REVIEW_MARKER}\n/bb-review` })],
  ])("ignores %s", async (_name, payload) => {
    const { post, spawnCalls, settle } = await setup();
    expect((await post(payload)).status).toBe(204);
    await settle();
    expect(spawnCalls()).toHaveLength(0);
  });

  it("ignores other events", async () => {
    const { post } = await setup();
    expect((await post({ zen: "hi" }, { event: "ping" })).status).toBe(204);
  });

  it("starts one review per comment even when redelivered", async () => {
    const { post, spawnCalls, settle } = await setup();
    expect((await post(commentPayload())).status).toBe(202);
    await settle();
    expect((await post(commentPayload())).status).toBe(200);
    await settle();
    expect(spawnCalls()).toHaveLength(1);
  });

  it("skips repos without a bb project", async () => {
    const { post, spawnCalls, settle, harness } = await setup();
    const payload = { ...commentPayload(), repository: { full_name: "someone/else" } };
    expect((await post(payload)).status).toBe(202);
    await settle();
    expect(spawnCalls()).toHaveLength(0);
    const runs = await harness.behavior.runCli(["runs", "--json"]);
    expect(JSON.parse(runs.stdout ?? "[]")[0]).toMatchObject({ status: "skipped" });
  });

  const readyPayload = (login = "jwellner", action = "ready_for_review") => ({
    action,
    pull_request: { number: 9, draft: false },
    sender: { login },
    repository: { full_name: "jwellner/website" },
  });

  it("starts a review when an allowed user marks a draft ready", async () => {
    const { post, spawnCalls, settle } = await setup();
    const res = await post(readyPayload(), { event: "pull_request", delivery: "d-1" });
    expect(res.status).toBe(202);
    await settle();
    expect(spawnCalls()).toHaveLength(1);
    const args = spawnCalls()[0]![0] as { title: string; prompt: string };
    expect(args.title).toBe("Review jwellner/website#9");
    expect(args.prompt).toContain("marked ready for review");
    // GitHub redelivers with the same delivery id.
    expect((await post(readyPayload(), { event: "pull_request", delivery: "d-1" })).status).toBe(200);
    await settle();
    expect(spawnCalls()).toHaveLength(1);
  });

  it.each([
    ["another pull_request action", readyPayload("jwellner", "opened")],
    ["a disallowed user", readyPayload("stranger")],
  ])("ignores %s", async (_name, payload) => {
    const { post, spawnCalls, settle } = await setup();
    expect((await post(payload, { event: "pull_request" })).status).toBe(204);
    await settle();
    expect(spawnCalls()).toHaveLength(0);
  });

  it("ignores ready_for_review when the setting is off", async () => {
    const { post } = await setup({ webhookSecret: SECRET, allowedUsers: "jwellner", reviewOnReadyForReview: false });
    expect((await post(readyPayload(), { event: "pull_request" })).status).toBe(204);
  });

  it("answers 503 until allowed users are set", async () => {
    const { post } = await setup({ webhookSecret: SECRET });
    expect((await post(commentPayload())).status).toBe(503);
  });

  it("answers 503 until a secret is set", async () => {
    const { post } = await setup({});
    expect((await post(commentPayload())).status).toBe(503);
  });
});

describe("review agent", () => {
  it("uses the project defaults when nothing is set", async () => {
    const { post, spawnCalls, settle } = await setup();
    await post(commentPayload());
    await settle();
    const args = spawnCalls()[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("providerId");
    expect(args).not.toHaveProperty("model");
    expect(args).not.toHaveProperty("reasoningLevel");
  });

  it("passes the configured provider, model and reasoning level", async () => {
    const { post, spawnCalls, settle } = await setup({
      webhookSecret: SECRET,
      allowedUsers: "jwellner",
      provider: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
    await post(commentPayload());
    await settle();
    expect(spawnCalls()[0]![0]).toMatchObject({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "high",
    });
  });
});

describe("permission mode", () => {
  const spawnedMode = async (settings: Record<string, string | boolean>) => {
    const { post, spawnCalls, settle } = await setup({ webhookSecret: SECRET, allowedUsers: "jwellner", ...settings });
    await post(commentPayload());
    await settle();
    return (spawnCalls()[0]![0] as { permissionMode?: string }).permissionMode;
  };

  it("uses the configured mode when the provider supports it", async () => {
    expect(await spawnedMode({})).toBe("auto");
  });

  it("falls back to the most restrictive supported mode", async () => {
    expect(await spawnedMode({ projectProvider: "acp-cursor" })).toBe("accept-edits");
    expect(await spawnedMode({ provider: "acp-cursor" })).toBe("accept-edits");
  });

  it("keeps an explicit mode the provider supports", async () => {
    expect(await spawnedMode({ provider: "acp-cursor", permissionMode: "full" })).toBe("full");
  });

  it("passes no mode for project-default", async () => {
    expect(await spawnedMode({ provider: "acp-cursor", permissionMode: "project-default" })).toBeUndefined();
  });
});

describe("commit status", () => {
  async function started() {
    const ctx = await setup();
    expect((await ctx.post(commentPayload())).status).toBe(202);
    await ctx.settle();
    const runs = JSON.parse((await ctx.harness.behavior.runCli(["runs", "--json"])).stdout ?? "[]");
    return { ...ctx, runId: runs[0].id as string };
  }
  const idle = (harness: Awaited<ReturnType<typeof setup>>["harness"]) =>
    harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1" }),
      lastAssistantText: "done",
    });

  it("goes pending on the PR head when the review starts", async () => {
    const { statuses, spawnCalls } = await started();
    expect(statuses).toEqual([
      expect.objectContaining({ repo: "jwellner/website", sha: "a".repeat(40), state: "pending", context: "bb review" }),
    ]);
    expect((spawnCalls()[0]![0] as { prompt: string }).prompt).toContain("bb github-review conclude");
  });

  it("takes the agent's verdict and keeps it when the thread goes idle", async () => {
    const { harness, statuses, runId } = await started();
    const url = "https://github.com/jwellner/website/pull/7#pullrequestreview-1";
    const res = await harness.behavior.runCli(["conclude", runId, "failure", "--url", url, "2 high findings"]);
    expect(res.exitCode).toBe(0);
    await idle(harness);
    await new Promise((r) => setTimeout(r, 10));
    expect(statuses.map((s) => s.state)).toEqual(["pending", "failure"]);
    expect(statuses[1]).toMatchObject({ description: "2 high findings", targetUrl: url });
  });

  it("errors when the thread ends without a verdict", async () => {
    const { harness, statuses } = await started();
    await idle(harness);
    await new Promise((r) => setTimeout(r, 10));
    expect(statuses.map((s) => s.state)).toEqual(["pending", "error"]);
  });

  it("is skipped when the setting is off", async () => {
    const { post, statuses, settle } = await setup({ webhookSecret: SECRET, allowedUsers: "jwellner", commitStatus: false });
    await post(commentPayload());
    await settle();
    expect(statuses).toHaveLength(0);
  });

  it("rejects bad conclude input", async () => {
    const { harness, runId } = await started();
    expect((await harness.behavior.runCli(["conclude", runId, "maybe"])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["conclude", runId, "success", "--url", "https://evil.example"])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["conclude", "nope", "success"])).exitCode).toBe(1);
  });
});

describe("setup", () => {
  const URL = "https://bb.example:8443/api/v1/plugins/github-review/http/webhook";
  const base = { webhookSecret: SECRET, allowedUsers: "jwellner", publicWebhookUrl: URL };
  const runSetup = async (
    args: string[],
    ctx: { cwd?: string; projectId?: string },
    hooks?: () => Promise<{ id: number; url: string; events: string[]; active: boolean }[]>,
  ) => {
    const { harness } = await setup(base, hooks);
    return harness.behavior.runCli(["setup", ...args], ctx as never);
  };

  it("detects the repo from the invoking bb project and hides the secret", async () => {
    const out = (await runSetup([], { projectId: "proj_web" })).stdout ?? "";
    expect(out).toContain("Repo:                jwellner/website  (from bb project");
    expect(out).toContain("gh api repos/jwellner/website/hooks");
    expect(out).toMatch(/config\[secret\]=\$\(cat '.*webhookSecret'\)|<secret: run with --show-secret>/);
    expect(out).not.toContain(SECRET);
  });

  it("detects the repo from the cwd checkout", async () => {
    const out = (await runSetup([], { cwd: "/work/website" })).stdout ?? "";
    expect(out).toContain("jwellner/website  (from git remote in /work/website)");
  });

  it("prints the secret only with --show-secret", async () => {
    const out = (await runSetup(["jwellner/website", "--show-secret"], {})).stdout ?? "";
    expect(out).toContain(`config[secret]=${SECRET}`);
  });

  it("prints only the missing events for an existing hook", async () => {
    const hooks = async () => [{ id: 42, url: URL, events: ["issue_comment"], active: true }];
    const out = (await runSetup(["jwellner/website"], {}, hooks)).stdout ?? "";
    expect(out).toContain("missing events: pull_request");
    expect(out).toContain("gh api -X PATCH repos/jwellner/website/hooks/42 -f 'add_events[]=pull_request'");
    expect(out).not.toContain("config[secret]");
  });

  it("says when the hook is complete", async () => {
    const hooks = async () => [{ id: 42, url: URL, events: ["issue_comment", "pull_request"], active: true }];
    const out = (await runSetup(["jwellner/website"], {}, hooks)).stdout ?? "";
    expect(out).toContain("installed (id 42");
    expect(out).toMatch(/^1\. Comment/m);
  });
});

describe("helpers", () => {
  it("extracts focus text after the keyword", () => {
    expect(extractFocus("/bb-review", "/bb-review")).toBe("");
    expect(extractFocus("hi\n  /BB-Review: perf\nand memory", "/bb-review")).toBe("perf\nand memory");
    expect(extractFocus("/bb-reviewer", "/bb-review")).toBeNull();
  });

  it("parses GitHub remotes", () => {
    expect(repoFromRemote("git@github.com:jwellner/website.git")).toBe("jwellner/website");
    expect(repoFromRemote("https://github.com/ORSCHAT/global-api")).toBe("orschat/global-api");
    expect(repoFromRemote("https://gitlab.com/a/b.git")).toBeNull();
  });
});
