import { julesClient } from "@/lib/jules/client";

export async function GET() {
  try {
    const sources = await julesClient.listSources();
    return Response.json({ sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list Jules sources";
    return Response.json({ error: message }, { status: 500 });
  }
}
