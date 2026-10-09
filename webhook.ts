// Pure webhook parsing and policy: no bb API, so it is unit-testable.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Hidden marker the review agent puts in everything it posts, so a posted
 * review can never trigger another review. */
export const REVIEW_MARKER = "<!-- bb-github-review -->";

export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FOCUS_CHARS = 2000;

/** Verify GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export type ReviewTrigger = "comment" | "ready_for_review" | "cli";

export interface ReviewRequest {
  trigger: ReviewTrigger;
  repo: string; // owner/name, lowercased
  pr: number;
  /** 0 when the review was not started by a comment. */
  commentId: number;
  commentUrl: string;
  author: string;
  focus: string;
}

export type ParseResult =
  | { kind: "review"; request: ReviewRequest }
  | { kind: "ignore"; reason: string };

export interface ParseOptions {
  keyword: string;
  allowedUsers: string[];
  reviewOnReadyForReview: boolean;
}

/** Decide whether a webhook delivery asks for a review. */
export function parseDelivery(
  event: string | null | undefined,
  payload: unknown,
  options: ParseOptions,
): ParseResult {
  if (event === "issue_comment") return parseIssueComment(payload, options);
  if (event === "pull_request") return parsePullRequest(payload, options);
  return { kind: "ignore", reason: event === "ping" ? "ping" : `event ${event ?? "(none)"}` };
}

function isAllowed(login: string, options: ParseOptions): boolean {
  return options.allowedUsers.some((u) => u.toLowerCase() === login.toLowerCase());
}

/** A draft PR marked ready for review by an allowed user. */
function parsePullRequest(payload: unknown, options: ParseOptions): ParseResult {
  const p = payload as {
    action?: unknown;
    pull_request?: { number?: unknown };
    sender?: { login?: unknown };
    repository?: { full_name?: unknown };
  };
  if (p?.action !== "ready_for_review") {
    return { kind: "ignore", reason: `pull_request action ${String(p?.action)}` };
  }
  if (!options.reviewOnReadyForReview) {
    return { kind: "ignore", reason: "ready_for_review trigger is off" };
  }
  const pr = p.pull_request?.number;
  const sender = p.sender?.login;
  const repo = p.repository?.full_name;
  if (typeof pr !== "number" || typeof sender !== "string" || typeof repo !== "string") {
    return { kind: "ignore", reason: "malformed payload" };
  }
  if (!isAllowed(sender, options)) return { kind: "ignore", reason: `user ${sender} not allowed` };
  return {
    kind: "review",
    request: {
      trigger: "ready_for_review",
      repo: repo.toLowerCase(),
      pr,
      commentId: 0,
      commentUrl: "",
      author: sender,
      focus: "",
    },
  };
}

/**
 * An `issue_comment` on a PR asks for a review when a line starts with the
 * keyword; the rest of that line plus later lines become the focus.
 */
function parseIssueComment(payload: unknown, options: ParseOptions): ParseResult {
  const p = payload as {
    action?: unknown;
    issue?: { number?: unknown; pull_request?: unknown };
    comment?: { id?: unknown; body?: unknown; html_url?: unknown; user?: { login?: unknown } };
    repository?: { full_name?: unknown };
  };
  if (p?.action !== "created") return { kind: "ignore", reason: `action ${String(p?.action)}` };
  if (!p.issue?.pull_request) return { kind: "ignore", reason: "not a pull request" };

  const pr = p.issue.number;
  const commentId = p.comment?.id;
  const body = p.comment?.body;
  const author = p.comment?.user?.login;
  const repo = p.repository?.full_name;
  if (
    typeof pr !== "number" ||
    typeof commentId !== "number" ||
    typeof body !== "string" ||
    typeof author !== "string" ||
    typeof repo !== "string"
  ) {
    return { kind: "ignore", reason: "malformed payload" };
  }
  if (body.includes(REVIEW_MARKER)) return { kind: "ignore", reason: "own review" };

  if (!isAllowed(author, options)) return { kind: "ignore", reason: `user ${author} not allowed` };

  const focus = extractFocus(body, options.keyword);
  if (focus === null) return { kind: "ignore", reason: "no keyword" };

  return {
    kind: "review",
    request: {
      trigger: "comment",
      repo: repo.toLowerCase(),
      pr,
      commentId,
      commentUrl: typeof p.comment?.html_url === "string" ? p.comment.html_url : "",
      author,
      focus,
    },
  };
}

/** Text after the keyword, or null when no line starts with it. */
export function extractFocus(body: string, keyword: string): string | null {
  const key = keyword.trim().toLowerCase();
  if (key === "") return null;
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart();
    if (!line.toLowerCase().startsWith(key)) continue;
    const next = line.charAt(key.length);
    // Whole-word match: `/bb-review` must not fire on `/bb-reviewer`.
    if (next !== "" && !/[\s:,.]/.test(next)) continue;
    const rest = [line.slice(key.length).replace(/^[\s:,.]+/, ""), ...lines.slice(i + 1)];
    return rest.join("\n").trim().slice(0, MAX_FOCUS_CHARS);
  }
  return null;
}

/** `owner/repo` from an https or ssh GitHub remote, lowercased. */
export function repoFromRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Parse `owner/repo=proj_id` pairs separated by commas or newlines. */
export function parseRepoProjects(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? "").split(/[,\n]/)) {
    const [repo, project] = entry.split("=").map((s) => s.trim());
    if (repo && project) map.set(repo.toLowerCase(), project);
  }
  return map;
}

export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
