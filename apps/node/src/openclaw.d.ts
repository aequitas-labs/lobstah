/**
 * Minimal ambient declaration for the OpenClaw plugin SDK surface this plugin
 * uses, so it compiles without openclaw installed. The gateway process that
 * loads the plugin resolves the real module; the real types are a superset.
 */
declare module 'openclaw/plugin-sdk/core' {
  export interface AgentToolResult {
    content: Array<{ type: 'text'; text: string }>;
    details: unknown;
  }
  export interface AnyAgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: unknown;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult>;
  }
  export interface PluginCommandContext {
    args?: string;
    commandBody: string;
    isAuthorizedSender: boolean;
  }
  export interface PluginCommandResult {
    text?: string;
  }
  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }
  export interface OpenClawPluginApi {
    registerTool(tool: AnyAgentTool, opts?: { optional?: boolean }): void;
    registerCommand(command: OpenClawPluginCommandDefinition): void;
  }
  export interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }
  export function definePluginEntry(options: DefinePluginEntryOptions): unknown;
}
