import { env } from 'cloudflare:workers';
import {
  PROTOCOL_VERSION,
  type ChangesMessage,
  type ClientMessage,
  type RecordPut,
  type Role,
  type ServerMessage,
} from '../../../shared/protocol';

let workspaceCounter = 0;

/** A fresh, isolated workspace (Durable Object instance) per test. */
export function newWorkspace() {
  workspaceCounter += 1;
  return env.WORKSPACE.getByName(`test-workspace-${workspaceCounter}-${crypto.randomUUID()}`);
}
export type Workspace = ReturnType<typeof newWorkspace>;

type Of<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

export interface TestSocket {
  readonly email: string;
  send(message: ClientMessage | Record<string, unknown>): void;
  sendRaw(data: string | ArrayBuffer): void;
  /** Wait for (and consume) the next message of this type. */
  next<T extends ServerMessage['t']>(type: T, timeoutMs?: number): Promise<Of<T>>;
  /** Assert that NO message of this type arrives within `ms`. */
  expectNone(type: ServerMessage['t'], ms?: number): Promise<void>;
  close(code?: number): void;
  closed: Promise<{ code: number }>;
  readonly isOpen: boolean;
}

/** Open a WebSocket to a workspace as a given verified identity (what the Worker would forward). */
export async function connect(
  workspace: Workspace,
  email = 'alice@example.com',
  role: Role = 'editor',
  expiresAt: number | null = null,
): Promise<TestSocket> {
  const response = await workspace.fetch(
    new Request('http://localhost/ws', {
      headers: {
        Upgrade: 'websocket',
        'x-gc-verified-email': email,
        'x-gc-verified-role': role,
        ...(expiresAt === null ? {} : { 'x-gc-verified-exp': String(expiresAt) }),
      },
    }),
  );
  if (response.status !== 101 || response.webSocket === null) throw new Error(`upgrade failed: ${response.status}`);
  return wrap(response.webSocket, email);
}

export function wrap(ws: WebSocket, email: string): TestSocket {
  ws.accept();
  const queue: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  let open = true;
  let resolveClosed!: (v: { code: number }) => void;
  const closed = new Promise<{ code: number }>((r) => (resolveClosed = r));

  ws.addEventListener('message', (event) => {
    queue.push(JSON.parse(event.data as string) as ServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  ws.addEventListener('close', (event) => {
    open = false;
    resolveClosed({ code: event.code });
    for (const w of waiters.splice(0)) w();
  });

  const take = <T extends ServerMessage['t']>(type: T): Of<T> | undefined => {
    const i = queue.findIndex((m) => m.t === type);
    return i === -1 ? undefined : (queue.splice(i, 1)[0] as Of<T>);
  };

  return {
    email,
    get isOpen() {
      return open;
    },
    closed,
    send: (message) => ws.send(JSON.stringify(message)),
    sendRaw: (data) => ws.send(data),
    close: (code = 1000) => ws.close(code, 'test'),
    async next(type, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = take(type);
        if (hit !== undefined) return hit;
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for '${type}' (queued: ${queue.map((m) => m.t).join(',') || 'none'})`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    async expectNone(type, ms = 250) {
      await new Promise((r) => setTimeout(r, ms));
      const hit = take(type);
      if (hit !== undefined) throw new Error(`unexpected '${type}': ${JSON.stringify(hit)}`);
    },
  };
}

/** Connect and complete the hello handshake. Returns the socket and what the server sent first. */
export async function join(
  workspace: Workspace,
  email = 'alice@example.com',
  lastRevision: number | null = null,
  role: Role = 'editor',
  expiresAt: number | null = null,
) {
  const sock = await connect(workspace, email, role, expiresAt);
  sock.send({ t: 'hello', v: PROTOCOL_VERSION, clientId: `client-${email}-${crypto.randomUUID()}`, lastRevision });
  const ready = await sock.next('ready');
  return { sock, ready };
}

export const rec = (kind: RecordPut['kind'], id: string, value: unknown): RecordPut => ({ kind, id, json: JSON.stringify(value) });

let commitSeq = 0;
export function commitMsg(baseRevision: number, puts: RecordPut[], deletes: Array<{ kind: RecordPut['kind']; id: string }> = [], id?: string) {
  commitSeq += 1;
  return { t: 'commit' as const, id: id ?? `commit-${commitSeq}`, baseRevision, puts, deletes };
}

export type { ChangesMessage };
