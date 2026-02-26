import type {
  AuditorReportState,
  OrchestratorRequest,
  StreamFinalEvent,
  StreamPhaseEvent,
  StreamToolResultEvent,
} from "@/lib/ui/types";

type StreamHandlers = {
  onStart?: () => void;
  onPhase?: (event: StreamPhaseEvent) => void;
  onDelta?: (text: string) => void;
  onToolResult?: (event: StreamToolResultEvent) => void;
  onFinal?: (event: StreamFinalEvent) => void;
  onError?: (error: string) => void;
  onDone?: () => void;
};

function parseSsePayload(raw: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = [];
  const blocks = raw.split("\n\n").map((block) => block.trim()).filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "message";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.replace("event:", "").trim();
      }
      if (line.startsWith("data:")) {
        data += line.replace("data:", "").trim();
      }
    }

    try {
      events.push({ event, data: JSON.parse(data) });
    } catch {
      events.push({ event, data });
    }
  }

  return events;
}

export async function streamOrchestratorReport(
  payload: OrchestratorRequest,
  handlers: StreamHandlers,
): Promise<void> {
  handlers.onStart?.();

  const response = await fetch("/api/orchestrator/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const message = await response.text();
    throw new Error(message || "Failed to connect to orchestration stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const eventRaw of parts) {
        const parsedEvents = parseSsePayload(eventRaw + "\n\n");
        for (const parsed of parsedEvents) {
          if (parsed.event === "phase") {
            handlers.onPhase?.(parsed.data as StreamPhaseEvent);
          } else if (parsed.event === "delta") {
            const data = parsed.data as { text?: string };
            handlers.onDelta?.(data.text ?? "");
          } else if (parsed.event === "tool_result") {
            handlers.onToolResult?.(parsed.data as StreamToolResultEvent);
          } else if (parsed.event === "final") {
            handlers.onFinal?.(parsed.data as StreamFinalEvent);
          } else if (parsed.event === "error") {
            const data = parsed.data as { error?: string };
            handlers.onError?.(data.error ?? "Stream error");
          }
        }
      }
    }

    handlers.onDone?.();
  } finally {
    reader.releaseLock();
  }
}

export function initialAuditorReportState(): AuditorReportState {
  return {
    phases: [],
    text: "",
    toolEvents: [],
    final: null,
    error: null,
    isStreaming: false,
  };
}
