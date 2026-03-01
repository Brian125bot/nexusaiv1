import { z } from "zod";
import { julesEnv } from "@/lib/config";

const createSessionResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  url: z.string().url().optional(),
});

const getSessionResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  url: z.string().url().optional(),
  outputs: z
    .object({
      pullRequest: z
        .object({
          url: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type JulesCreateSessionInput = {
  prompt: string;
  sourceRepo: string;
  startingBranch: string;
  auditorContext: string;
};

export type JulesSession = z.infer<typeof getSessionResponseSchema>;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export class JulesClient {
  private getConfig() {
    return {
      apiKey: julesEnv.JULES_API_KEY,
      baseUrl: julesEnv.JULES_API_BASE_URL,
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const config = this.getConfig();
    const response = await fetch(joinUrl(config.baseUrl, path), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.apiKey,
        ...init?.headers,
      },
    });

    const responseText = await response.text();
    const payload = responseText ? (JSON.parse(responseText) as unknown) : undefined;

    if (!response.ok) {
      const errorMessage =
        typeof payload === "object" && payload !== null && "error" in payload
          ? JSON.stringify(payload)
          : `Jules API request failed with status ${response.status}`;
      throw new Error(errorMessage);
    }

    return payload as T;
  }

  async createSession(input: JulesCreateSessionInput): Promise<{ id: string; url: string }> {
    const payload = {
      prompt: `${input.prompt}\n\n--- AUDITOR CONTEXT ---\n${input.auditorContext}\n--- END AUDITOR CONTEXT ---`,
      sourceContext: {
        source: `sources/github/${input.sourceRepo}`,
        githubRepoContext: {
          startingBranch: input.startingBranch,
        },
      },
      automationMode: "AUTO_CREATE_PR",
    };

    const raw = await this.request<unknown>("sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const parsed = createSessionResponseSchema.parse(raw);
    return {
      id: parsed.id,
      url: parsed.url ?? `https://jules.google.com/session/${parsed.id}`,
    };
  }

  async getSession(sessionId: string): Promise<JulesSession> {
    const raw = await this.request<unknown>(`sessions/${sessionId}`, {
      method: "GET",
    });

    return getSessionResponseSchema.parse(raw);
  }

  async listSources(): Promise<unknown> {
    return await this.request<unknown>("sources", { method: "GET" });
  }
}

export const julesClient = new JulesClient();
