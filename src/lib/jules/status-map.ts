import { sessionStatusEnum } from "@/db/schema";

export type RegistrySessionStatus = (typeof sessionStatusEnum.enumValues)[number];

export function mapJulesStatusToRegistryStatus(status: string): RegistrySessionStatus | null {
  switch (status) {
    case "PLANNING":
    case "RUNNING":
      return "executing";
    case "COMPLETED":
      return "completed";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    default:
      return null;
  }
}
