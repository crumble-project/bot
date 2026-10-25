import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The guest path where a bot's workspace lives; coding jobs start here. */
export const WORKSPACE_PATH = "/workspace";

/** Where the guest keeps the bot's credential proxy authority, which `update-ca-certificates` adds to the bundle. */
export const GUEST_CA_PATH =
  "/usr/local/share/ca-certificates/crumble-credentials.crt";

/** The guest's system bundle: public authorities plus the bot's. */
export const GUEST_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** A byte stream to the bot desktop's VNC server; closing it releases the machine for its idle stop. */
export type DesktopStream = {
  write(data: Uint8Array): Promise<void>;
  output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

/** An outbound connection from a bot's workspace, named by its TLS server name or HTTP `Host`. */
export type WorkspaceRequest = { agentId: string; host: string; port: number };

/**
 * Decides a workspace's outbound connections before they leave the machine. A connection waits while the policy does,
 * so an owner-approval flow can replace the default.
 */
export type WorkspaceNetworkPolicy = (
  request: WorkspaceRequest,
) => boolean | Promise<boolean>;

/** Trusts every request to the internet. */
export const allowAllRequests: WorkspaceNetworkPolicy = () => true;

/**
 * Each bot's persistent coding workspace: a disk only that bot's coding jobs can reach. The machine behind it starts
 * on first use and may stop when idle; the workspace's files survive both.
 */
export interface Workspaces {
  /**
   * The bot's environment. Lazy: nothing starts until its first operation. Every command it runs also sees `shellEnv`.
   */
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  /** Whether bots can get a bot desktop: the workspace image for them has one. */
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  restart(agentId: string, context: Context): Promise<void>;
  /**
   * Connects to the bot desktop's VNC server, booting the machine if needed. The machine stays awake until the stream
   * closes. Rejects for a bot without its bot desktop.
   */
  openDesktop(agentId: string, context: Context): Promise<DesktopStream>;
  /** Boots the bot's machine ahead of `openDesktop`, so a viewer about to connect waits less. */
  startDesktop(agentId: string, context: Context): Promise<void>;
  /** Keeps the bot's machine from its idle stop until the returned release is called. */
  keepAwake(agentId: string): () => void;
  /** Makes completed writes in the bot's workspace durable. A stopped workspace has nothing to flush. */
  sync(agentId: string, context: Context): Promise<void>;
  /** Flushes and stops every running workspace. */
  close(context: Context): Promise<void>;
}
