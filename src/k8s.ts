/**
 * Provisions/tears down the per-room runner Pod+Secret+Service in the
 * `coding-agent-rooms` namespace. The broker's own ServiceAccount is scoped
 * (via a namespaced Role/RoleBinding, see apps/coding-agent/role.yaml in the
 * gitops repo) to create/get/list/delete exactly these three kinds, only in
 * that one namespace — it has no access to its own namespace or anywhere else.
 */
import * as crypto from "node:crypto";
import * as k8s from "@kubernetes/client-node";

const ROOMS_NS = process.env.ROOMS_NAMESPACE ?? "coding-agent-rooms";
const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? "ghcr.io/lab3ss/coding-agent-runner:0.1.0";
const OPENCODE_PORT = 4096;

// Created lazily on first API use rather than at import time: loadFromDefault
// touches the filesystem/env and throws when no config source exists, which
// would make merely importing this module (e.g. from tests) fail outside a
// cluster. loadFromDefault resolves kubeconfig (KUBECONFIG / ~/.kube/config)
// when running locally, and falls back to the in-cluster ServiceAccount
// config in production — same behavior as before in the pod, plus real local
// dev against a reachable cluster API.
let cachedCore: k8s.CoreV1Api | undefined;
function coreApi(): k8s.CoreV1Api {
  if (!cachedCore) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    cachedCore = kc.makeApiClient(k8s.CoreV1Api);
  }
  return cachedCore;
}

/**
 * DNS-safe (<=63 char) name for a room's Pod/Secret/Service: a kebab-cased
 * slug of the room's display name (if any), plus the roomId hash so it stays
 * unique even if two rooms share a name. The slug is purely cosmetic — for
 * `kubectl logs`/`get pod` by eye — so it's computed once at provision time
 * and stored on the Room; a later room rename doesn't change it.
 */
export function roomResourceName(roomId: string, roomName?: string): string {
  const hash = crypto.createHash("sha1").update(roomId).digest("hex").slice(0, 16);
  const slug = (roomName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63 - "room-".length - 1 - hash.length)
    .replace(/-+$/g, "");
  return slug ? `room-${slug}-${hash}` : `room-${hash}`;
}

export type RoomEnv = { repo: string; token: string; openrouterKey: string };

async function ignoringConflict(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    if (err?.code !== 409) throw err;
  }
}

/** Reads back the room's actual OPENCODE_SERVER_PASSWORD from its live Secret. */
export async function getRoomServerPassword(name: string): Promise<string> {
  const secret = await coreApi().readNamespacedSecret({ name, namespace: ROOMS_NS });
  return Buffer.from(secret.data!.OPENCODE_SERVER_PASSWORD, "base64").toString("utf8");
}

/**
 * Idempotent: safe to call again after a partial failure (e.g. the Secret
 * and Pod got created but the readiness wait then failed) — already-existing
 * resources are left as-is rather than erroring on "already exists".
 *
 * `agentRules` (optional) is the chat channel's formatting capability profile
 * (e.g. Matrix needs plain-text-only agent output); the runner applies it in
 * place of its baked-in default rules.
 *
 * Returns the room's actual OPENCODE_SERVER_PASSWORD, read back from the
 * Secret rather than trusting a freshly-generated one — if the Secret
 * already existed (idempotent create skipped it), the running pod still has
 * whatever password was baked in on its FIRST creation, so generating a new
 * one here and using that for auth would silently mismatch (401).
 */
export async function provisionRoom(name: string, env: RoomEnv, agentRules?: string): Promise<string> {
  await ignoringConflict(() =>
    coreApi().createNamespacedSecret({
      namespace: ROOMS_NS,
      body: {
        metadata: { name },
        stringData: {
          REPO: env.repo,
          GH_TOKEN: env.token,
          OPENCODE_SERVER_PASSWORD: crypto.randomBytes(16).toString("hex"),
          OPENROUTER_API_KEY: env.openrouterKey,
          ...(agentRules ? { AGENT_RULES: agentRules } : {}),
        },
      },
    }),
  );
  const serverPassword = await getRoomServerPassword(name);

  await ignoringConflict(() =>
    coreApi().createNamespacedPod({
      namespace: ROOMS_NS,
      body: {
        metadata: { name, labels: { app: "coding-agent-room", room: name } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
          containers: [
            {
              name: "runner",
              image: RUNNER_IMAGE,
              envFrom: [{ secretRef: { name } }],
              ports: [{ name: "http", containerPort: OPENCODE_PORT }],
              resources: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: { cpu: "2", memory: "2Gi" },
              },
            },
          ],
        },
      },
    }),
  );

  await ignoringConflict(() =>
    coreApi().createNamespacedService({
      namespace: ROOMS_NS,
      body: {
        metadata: { name },
        spec: { selector: { room: name }, ports: [{ name: "http", port: OPENCODE_PORT, targetPort: OPENCODE_PORT }] },
      },
    }),
  );

  return serverPassword;
}

/** In-cluster base URL for a room's opencode server (stable even if the pod restarts). */
export function roomServerUrl(name: string): string {
  return `http://${name}.${ROOMS_NS}.svc.cluster.local:${OPENCODE_PORT}`;
}

async function ignoring404<T>(fn: () => Promise<T>): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }
}

export async function teardownRoom(name: string): Promise<void> {
  await ignoring404(() => coreApi().deleteNamespacedPod({ name, namespace: ROOMS_NS }));
  await ignoring404(() => coreApi().deleteNamespacedService({ name, namespace: ROOMS_NS }));
  await ignoring404(() => coreApi().deleteNamespacedSecret({ name, namespace: ROOMS_NS }));
}

export type RoomPodState = "running" | "pending" | "gone" | "failed";

/**
 * One GET (same grant waitForRunning uses): where is this room's pod, really?
 * "gone" covers out-of-band deletion (node reboot, eviction, manual kubectl)
 * and "failed"/"succeeded" a dead container (e.g. OOM-kill — restartPolicy is
 * Never, so a crashed runner stays dead). Callers use this to self-heal a
 * registry row that still points at a pod that no longer answers.
 */
export async function readRoomPodState(name: string): Promise<RoomPodState> {
  try {
    const pod = await coreApi().readNamespacedPod({ name, namespace: ROOMS_NS });
    if (pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded") return "failed";
    if (pod.status?.containerStatuses?.some((c) => c.state?.running)) return "running";
    return "pending";
  } catch (err: any) {
    if (err?.code === 404) return "gone";
    throw err;
  }
}

// restartPolicy is Never, so CrashLoopBackOff can't actually loop — but it (and the
// image-pull failures) tell us the pod will never start, i.e. waiting the full timeout
// would just burn a minute before reporting what we already know.
const FATAL_WAIT_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CrashLoopBackOff",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
]);

/**
 * Poll until the pod's container is Running (not just Pending/ContainerCreating).
 * Uses a plain GET on the pod (already covered by the Role's "pods" grant) —
 * its .status field is included on read; only *writing* status needs the
 * separate pods/status subresource permission, which the broker doesn't need.
 */
export async function waitForRunning(name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await coreApi().readNamespacedPod({ name, namespace: ROOMS_NS });
    const running = pod.status?.containerStatuses?.some((c) => c.state?.running);
    if (running) return;
    if (pod.status?.phase === "Failed") throw new Error(`room pod ${name} failed to start`);
    const waiting = pod.status?.containerStatuses?.find((c) => c.state?.waiting)?.state?.waiting;
    if (waiting && FATAL_WAIT_REASONS.has(waiting.reason ?? "")) {
      throw new Error(`room pod ${name} cannot start: ${waiting.reason} ${waiting.message ?? ""}`.trim());
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`room pod ${name} did not become Running within ${timeoutMs}ms`);
}
