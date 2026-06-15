import type { DailySummaryWirePayload } from './stats/summary-formatter.js';

export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  notification_type?: string;
  message?: string;
}

export type AgentEventType =
  | 'permission_prompt'
  | 'task_complete'
  | 'session_error'
  | 'idle_waiting'
  | 'session_started'
  | 'session_ended'
  | 'session_updated'
  | 'heartbeat'
  | 'full_sync'
  | 'daily_stats_update';

export interface AgentEvent {
  type: AgentEventType;
  session_id: string;
  project_name: string;
  cwd: string;
  agent: 'claude-code' | 'codex' | 'amp';
  message: string;
  permission_command?: string;
  tool_name?: string;
  tool_input?: string;
  timestamp: string;
  pid?: string;
  /** Present only when type === 'daily_stats_update'. */
  summary?: DailySummaryWirePayload;
}

export interface FullSyncEvent extends AgentEvent {
  type: 'full_sync';
  sessions: AgentEvent[];
}

export type PhoneCommandType = 'approve' | 'deny' | 'send_prompt' | 'heartbeat' | 'register_fcm_token';

export interface PhoneCommand {
  type: PhoneCommandType;
  session_id: string;
  payload?: string;
  /** FCM registration token — present on 'register_fcm_token' commands. */
  token?: string;
  /** Human-readable phone name — present on 'register_fcm_token' commands. */
  device_name?: string;
}
