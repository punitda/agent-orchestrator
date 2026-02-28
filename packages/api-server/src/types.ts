/**
 * API response types for the mobile API server.
 *
 * These types define the JSON shape returned by API endpoints.
 * Core types (Date objects, internal fields) are mapped to
 * serializable, client-safe representations.
 */

import type {
  ActivityState,
  CIStatus,
  ReviewDecision,
  SessionStatus,
} from "@composio/ao-core";

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

/** A single session as returned by the list API. */
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

// ---------------------------------------------------------------------------
// Session detail types (GET /api/v1/sessions/:id)
// ---------------------------------------------------------------------------

/** Enriched PR info with CI, review, and merge data. */
export interface PRDetailResponse extends SessionPR {
  ciStatus: CIStatus;
  reviewDecision: ReviewDecision;
  mergeable: boolean;
}

/** Cost estimate from the agent plugin. */
export interface CostResponse {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/** Session detail response with enriched PR and cost data. */
export interface SessionDetailResponse extends Omit<SessionResponse, "pr" | "agentInfo"> {
  pr: PRDetailResponse | null;
  agentInfo: {
    summary: string | null;
    cost: CostResponse | null;
  };
}
