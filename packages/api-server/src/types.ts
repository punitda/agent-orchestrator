/**
 * API response types for the mobile API server.
 *
 * These types define the JSON shape returned by API endpoints.
 * Core types (Date objects, internal fields) are mapped to
 * serializable, client-safe representations.
 */

import type { ActivityState, SessionStatus } from "@composio/ao-core";

/** Basic PR info included in session list responses (no CI/review enrichment). */
export interface SessionPR {
  number: number;
  url: string;
  state: "open" | "merged" | "closed";
}

/** Agent summary info included in session responses. */
export interface SessionAgentInfo {
  summary: string;
}

/** A single session as returned by the API. */
export interface SessionResponse {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState | null;
  branch: string | null;
  issueId: string | null;
  createdAt: string;
  lastActivityAt: string;
  pr: SessionPR | null;
  agentInfo: SessionAgentInfo | null;
}
