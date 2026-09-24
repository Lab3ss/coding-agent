/**
 * Broker entry point — composition root only.
 *
 * Everything the broker does lives in two places now:
 *   - src/core/   — the transport-neutral orchestrator (onboarding, commands,
 *     approvals, provisioning, retries, teardown) behind Effect services
 *   - src/adapter/ — chat transports (Matrix today) implementing ChatAdapter
 *
 * This file validates env, builds the Effect layers, wires the adapter's
 * inbound stream into the orchestrator, and starts. A second chat platform is
 * a new adapter + a different layer here — no core changes.
 *
 * Requires: MATRIX_HOMESERVER, MATRIX_TOKEN (this bot's account),
 * OPENROUTER_API_KEY (the one and only LLM credential, shared into every
 * room's pod at provision time — never stored per-room in Git).
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { MatrixAdapterLive } from "./adapter/matrix.ts";
import { Orchestrator, OrchestratorLive } from "./core/orchestrator.ts";
import { RegistryLive } from "./core/registry-service.ts";
import { WorkspaceLive } from "./core/workspace.ts";

const homeserver = process.env.MATRIX_HOMESERVER!;
const matrixToken = process.env.MATRIX_TOKEN!;
const openrouterKey = process.env.OPENROUTER_API_KEY!;

if (!homeserver || !matrixToken) throw new Error("MATRIX_HOMESERVER and MATRIX_TOKEN required");
if (!openrouterKey) throw new Error("OPENROUTER_API_KEY required");

const orchestratorConfig = {
  idleTeardownMs: parseFloat(process.env.IDLE_TEARDOWN_HOURS ?? "24") * 3600_000,
  sweepIntervalMs: 15 * 60_000,
};

const AppLayer = OrchestratorLive(orchestratorConfig).pipe(
  Layer.provide(RegistryLive),
  Layer.provide(WorkspaceLive({ openrouterKey })),
  Layer.provide(MatrixAdapterLive({ homeserver, token: matrixToken, storagePath: "bot-state.json" })),
);

const runtime = ManagedRuntime.make(AppLayer);

await runtime.runPromise(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    yield* orchestrator.start; // hooks the adapter's inbound stream + idle sweep
  }),
);

console.log("[coding-agent] listening. Invite me to a room to onboard a project.");
