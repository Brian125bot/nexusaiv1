import { Octokit } from "@octokit/rest";
import { githubEnv } from "@/lib/config";

function getGitHubToken(): string {
  return githubEnv.GITHUB_TOKEN;
}

export class GitHubClient {
  private getOctokit(): Octokit {
    return new Octokit({ auth: getGitHubToken() });
  }

  async getCommitDiff(owner: string, repo: string, sha: string): Promise<string> {
    const octokit = this.getOctokit();

    const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: sha,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    if (typeof response.data !== "string") {
      throw new Error("GitHub commit diff response was not text");
    }

    return response.data;
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const octokit = this.getOctokit();

    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    if (typeof response.data !== "string") {
      throw new Error("GitHub pull request diff response was not text");
    }

    return response.data;
  }

  async getCheckRunLogs(owner: string, repo: string, checkRunId: number): Promise<string | null> {
    const octokit = this.getOctokit();
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
        owner,
        repo,
        job_id: checkRunId,
      });
      return response.data as string;
    } catch (e) {
      console.warn("Failed to fetch check run logs", e);
      return null;
    }
  }

  async postPullRequestComment(owner: string, repo: string, pullNumber: number, body: string): Promise<void> {
    const octokit = this.getOctokit();

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  async postCommitComment(owner: string, repo: string, commitSha: string, body: string): Promise<void> {
    const octokit = this.getOctokit();

    await octokit.repos.createCommitComment({
      owner,
      repo,
      commit_sha: commitSha,
      body,
    });
  }
}

export const githubClient = new GitHubClient();
