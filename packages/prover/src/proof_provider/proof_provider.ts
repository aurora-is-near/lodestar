import {Api, getClient} from "@lodestar/api/beacon";
import {ChainForkConfig, createChainForkConfig} from "@lodestar/config";
import {networksChainConfig} from "@lodestar/config/networks";
import {Lightclient, LightclientEvent, RunStatusCode} from "@lodestar/light-client";
import {LightClientRestTransport} from "@lodestar/light-client/transport";
import {isForkWithdrawals} from "@lodestar/params";
import {allForks, capella} from "@lodestar/types";
import {LCTransport, RootProviderInitOptions} from "../interfaces.js";
import {assertLightClient} from "../utils/assertion.js";
import {
  getExecutionPayloads,
  getGenesisData,
  getSyncCheckpoint,
  getUnFinalizedRangeForPayloads,
} from "../utils/consensus.js";
import {PayloadStore} from "./payload_store.js";

type RootProviderOptions = Omit<RootProviderInitOptions, "transport"> & {
  transport: LightClientRestTransport;
  api: Api;
  config: ChainForkConfig;
};

export class ProofProvider {
  private store: PayloadStore;

  // Make sure readyPromise doesn't throw unhandled exceptions
  private readyPromise?: Promise<void>;
  lightClient?: Lightclient;

  constructor(private opts: RootProviderOptions) {
    this.store = new PayloadStore({api: opts.api});
  }

  async waitToBeReady(): Promise<void> {
    return this.readyPromise;
  }

  static init(opts: RootProviderInitOptions): ProofProvider {
    if (opts.transport === LCTransport.P2P) {
      throw new Error("P2P mode not supported yet");
    }

    const config = createChainForkConfig(networksChainConfig[opts.network]);
    const api = getClient({urls: opts.urls}, {config});
    const transport = new LightClientRestTransport(api);

    const provider = new ProofProvider({
      ...opts,
      config,
      api,
      transport,
    });

    provider.readyPromise = provider.sync(opts.wsCheckpoint).catch((e) => {
      // TODO: will be replaced by logger in the next PR.
      // eslint-disable-next-line no-console
      console.error("Error while syncing", e);
      return Promise.reject("Error while syncing");
    });

    return provider;
  }

  private async sync(wsCheckpoint?: string): Promise<void> {
    if (this.lightClient !== undefined) {
      throw Error("Light client already initialized and syncing.");
    }

    const {api, config, transport} = this.opts;
    const checkpointRoot = await getSyncCheckpoint(api, wsCheckpoint);
    const genesisData = await getGenesisData(api);

    this.lightClient = await Lightclient.initializeFromCheckpointRoot({
      checkpointRoot,
      config,
      transport,
      genesisData,
    });

    assertLightClient(this.lightClient);
    // Wait for the lightclient to start
    await new Promise<void>((resolve) => {
      const lightClientStarted = (status: RunStatusCode): void => {
        if (status === RunStatusCode.started) {
          this.lightClient?.emitter.off(LightclientEvent.statusChange, lightClientStarted);
          resolve();
        }
      };
      this.lightClient?.emitter.on(LightclientEvent.statusChange, lightClientStarted);
      this.lightClient?.start();
    });
    this.registerEvents();

    // Load the payloads from the CL
    const {start, end} = await getUnFinalizedRangeForPayloads(this.lightClient);
    const payloads = await getExecutionPayloads(this.opts.api, start, end);
    for (const payload of Object.values(payloads)) {
      this.store.set(payload, false);
    }

    // Load the finalized payload from the CL
    const finalizedSlot = this.lightClient.getFinalized().beacon.slot;
    const finalizedPayload = await getExecutionPayloads(this.opts.api, finalizedSlot, finalizedSlot);
    this.store.set(finalizedPayload[finalizedSlot], true);
  }

  getStatus(): {latest: number; finalized: number; status: RunStatusCode} {
    if (!this.lightClient) {
      return {
        latest: 0,
        finalized: 0,
        status: RunStatusCode.uninitialized,
      };
    }

    return {
      latest: this.lightClient.getHead().beacon.slot,
      finalized: this.lightClient.getFinalized().beacon.slot,
      status: this.lightClient.status,
    };
  }

  async getExecutionPayload(blockNumber: number | string | "finalized" | "latest"): Promise<allForks.ExecutionPayload> {
    assertLightClient(this.lightClient);

    if (typeof blockNumber === "string" && blockNumber === "finalized") {
      const payload = this.store.finalized;
      if (!payload) throw new Error("No finalized payload");
      return payload;
    }

    if (typeof blockNumber === "string" && blockNumber === "latest") {
      const payload = this.store.latest;
      if (!payload) throw new Error("No latest payload");
      return payload;
    }

    if ((typeof blockNumber === "string" && blockNumber.startsWith("0x")) || typeof blockNumber === "number") {
      const payload = await this.store.get(blockNumber);
      if (!payload) throw new Error(`No payload for blockNumber ${blockNumber}`);
      return payload;
    }

    throw new Error(`Invalid blockNumber "${blockNumber}"`);
  }

  async processLCHeader(lcHeader: allForks.LightClientHeader, finalized = false): Promise<void> {
    const fork = this.opts.config.getForkName(lcHeader.beacon.slot);

    if (!isForkWithdrawals(fork)) {
      return;
    }

    const sszType = this.opts.config.getExecutionForkTypes(lcHeader.beacon.slot).ExecutionPayloadHeader;
    if (
      isForkWithdrawals(fork) &&
      (!("execution" in lcHeader) || sszType.equals(lcHeader.execution, sszType.defaultValue()))
    ) {
      throw new Error("Execution payload is required for execution fork");
    }

    await this.store.processLCHeader(lcHeader as capella.LightClientHeader, finalized);
  }

  private registerEvents(): void {
    assertLightClient(this.lightClient);

    this.opts.signal.addEventListener("abort", () => {
      this.lightClient?.stop();
    });

    this.lightClient.emitter.on(LightclientEvent.lightClientFinalityHeader, async (data) => {
      await this.processLCHeader(data, true).catch((e) => {
        // Will be replaced with logger in next PR.
        // eslint-disable-next-line no-console
        console.error(e);
      });
    });

    this.lightClient.emitter.on(LightclientEvent.lightClientOptimisticHeader, async (data) => {
      await this.processLCHeader(data).catch((e) => {
        // Will be replaced with logger in next PR.
        // eslint-disable-next-line no-console
        console.error(e);
      });
    });
  }
}
