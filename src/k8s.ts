/**
 * Provisions/tears down the per-room runner Pod+Secret+Service in the
 * `coding-agent-rooms` namespace. The broker's own ServiceAccount is scoped
 * (via a namespaced Role/RoleBinding, see apps/coding-agent/role.yaml in the
 * gitops repo) to create/get/list/delete exactly these three kinds, only in
 * that one namespace — it has no access to its own namespace or anywhere else.
 */
import * as crypto from "node:crypto";
import * as k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromCluster();
const core = kc.makeApiClient(k8s.CoreV1Api);

const ROOMS_NS = process.env.ROOMS_NAMESPACE ?? "coding-agent-rooms";
const RUNNER_IMAGE = process.env.RUNNER_IMAGE ?? "ghcr.io/lab3ss/coding-agent-runner:0.1.0";
const OPENCODE_PORT = 4096;

/** Deterministic, DNS-safe (<=63 char) name for a room's Pod/Secret/Service. */
export function roomResourceName(roomId: string): string {
  return `room-${crypto.createHash("sha1").update(roomId).digest("hex").slice(0, 16)}`;
}

export type RoomEnv = { repo: string; token: string; openrouterKey: string };

/** Random Basic-Auth password opencode's server uses to gate its own API. */
export function newServerPassword(): string {
  return crypto.randomBytes(16).toString("hex");
}

export async function provisionRoom(name: string, env: RoomEnv, serverPassword: string): Promise<void> {
  await core.createNamespacedSecret({
    namespace: ROOMS_NS,
    body: {
      metadata: { name },
      stringData: {
        REPO: env.repo,
        GH_TOKEN: env.token,
        OPENCODE_SERVER_PASSWORD: serverPassword,
        OPENROUTER_API_KEY: env.openrouterKey,
      },
    },
  });

  await core.createNamespacedPod({
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
  });

  await core.createNamespacedService({
    namespace: ROOMS_NS,
    body: {
      metadata: { name },
      spec: { selector: { room: name }, ports: [{ name: "http", port: OPENCODE_PORT, targetPort: OPENCODE_PORT }] },
    },
  });
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
  await ignoring404(() => core.deleteNamespacedPod({ name, namespace: ROOMS_NS }));
  await ignoring404(() => core.deleteNamespacedService({ name, namespace: ROOMS_NS }));
  await ignoring404(() => core.deleteNamespacedSecret({ name, namespace: ROOMS_NS }));
}

/** Poll until the pod's container is Running (not just Pending/ContainerCreating). */
export async function waitForRunning(name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await core.readNamespacedPodStatus({ name, namespace: ROOMS_NS });
    const running = pod.status?.containerStatuses?.some((c) => c.state?.running);
    if (running) return;
    if (pod.status?.phase === "Failed") throw new Error(`room pod ${name} failed to start`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`room pod ${name} did not become Running within ${timeoutMs}ms`);
}
