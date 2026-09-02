import {
  createAndStartServer,
  type ServerConfig
} from "../../server/src/server.js";

export type InterviewServerInstance = Awaited<ReturnType<typeof createAndStartServer>>;
export type InterviewServerFactory = (config: ServerConfig) => Promise<InterviewServerInstance>;

export class DesktopBackendController {
  private instance: InterviewServerInstance | undefined;
  private starting: Promise<InterviewServerInstance> | undefined;
  private stopping: Promise<void> | undefined;
  private configFingerprint: string | undefined;
  private stopFailure: unknown;

  public constructor(
    private readonly factory: InterviewServerFactory = createAndStartServer
  ) {}

  public start(config: ServerConfig): Promise<InterviewServerInstance> {
    if (this.stopping !== undefined) {
      return Promise.reject(new Error("Desktop backend is shutting down"));
    }
    if (this.stopFailure !== undefined) {
      return Promise.reject(new Error(
        "Desktop backend cannot restart after a failed shutdown until stop succeeds",
        { cause: this.stopFailure }
      ));
    }

    const acceptedConfig = snapshotServerConfig(config);
    const fingerprint = fingerprintServerConfig(acceptedConfig);

    if (this.instance !== undefined) {
      this.assertSameConfig(fingerprint);
      return Promise.resolve(this.instance);
    }
    if (this.starting !== undefined) {
      this.assertSameConfig(fingerprint);
      return this.starting;
    }

    this.configFingerprint = fingerprint;
    const starting = this.factory(acceptedConfig)
      .then((instance) => {
        this.instance = instance;
        return instance;
      })
      .catch((error: unknown) => {
        if (this.starting === starting) {
          this.configFingerprint = undefined;
        }
        throw error;
      });
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    }).catch(() => undefined);
    return starting;
  }

  public stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    const stopping = this.stopCurrent();
    this.stopping = stopping;
    void stopping.finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    }).catch(() => undefined);
    return stopping;
  }

  public get started(): boolean {
    return this.instance !== undefined;
  }

  private assertSameConfig(fingerprint: string): void {
    if (this.configFingerprint !== fingerprint) {
      throw new Error("Desktop backend is already starting or started with a different configuration");
    }
  }

  private async stopCurrent(): Promise<void> {
    let instance = this.instance;
    if (instance === undefined && this.starting !== undefined) {
      try {
        instance = await this.starting;
      } catch {
        return;
      }
    }
    if (instance === undefined) return;

    try {
      await instance.stop();
    } catch (error) {
      this.stopFailure = error;
      throw error;
    }

    if (this.instance === instance) this.instance = undefined;
    this.configFingerprint = undefined;
    this.stopFailure = undefined;
  }
}

function snapshotServerConfig(config: ServerConfig): ServerConfig {
  const supportedKeys = new Set([
    "host",
    "commandPort",
    "rendererStreamPort",
    "voicePort",
    "clientToken",
    "allowedOrigins",
    "databasePath"
  ]);
  for (const key of Object.keys(config)) {
    if (!supportedKeys.has(key)) {
      throw new Error(`Desktop backend configuration contains unsupported field "${key}"`);
    }
  }

  return {
    ...(config.host !== undefined ? { host: config.host } : {}),
    ...(config.commandPort !== undefined ? { commandPort: config.commandPort } : {}),
    ...(config.rendererStreamPort !== undefined
      ? { rendererStreamPort: config.rendererStreamPort }
      : {}),
    ...(config.voicePort !== undefined ? { voicePort: config.voicePort } : {}),
    ...(config.clientToken !== undefined ? { clientToken: config.clientToken } : {}),
    ...(config.allowedOrigins !== undefined
      ? { allowedOrigins: [...config.allowedOrigins] }
      : {}),
    ...(config.databasePath !== undefined ? { databasePath: config.databasePath } : {})
  };
}

function fingerprintServerConfig(config: ServerConfig): string {
  const allowedOrigins = config.allowedOrigins === undefined
    ? undefined
    : [...new Set(config.allowedOrigins)].sort();
  return JSON.stringify({
    host: config.host,
    commandPort: config.commandPort,
    rendererStreamPort: config.rendererStreamPort,
    voicePort: config.voicePort,
    clientToken: config.clientToken,
    allowedOrigins,
    databasePath: config.databasePath
  });
}
