// セッショントークンの保存（sessionStorage）。合言葉そのものは保存しない。
export type Role = "viewer" | "admin";

interface Stored {
  token: string;
  expiresAt: string;
}

const KEYS: Record<Role, string> = { viewer: "snico.session.viewer", admin: "snico.session.admin" };
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// sessionStorage が使えない環境（プライベートモードの一部など）ではメモリに保持
const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  const s = storage();
  try {
    return s ? s.getItem(key) : (memory.get(key) ?? null);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string | null) {
  const s = storage();
  try {
    if (s) {
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
      return;
    }
  } catch {
    // フォールバック
  }
  if (value === null) memory.delete(key);
  else memory.set(key, value);
}

export function getToken(role: Role): string | null {
  const raw = readRaw(KEYS[role]);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Stored;
    // 期限の30秒前には期限切れとして扱う
    if (new Date(s.expiresAt).getTime() - 30_000 <= Date.now()) {
      writeRaw(KEYS[role], null);
      return null;
    }
    return s.token;
  } catch {
    writeRaw(KEYS[role], null);
    return null;
  }
}

export function setToken(role: Role, token: string, expiresAt: string) {
  writeRaw(KEYS[role], JSON.stringify({ token, expiresAt } satisfies Stored));
  emit();
}

export function clearToken(role: Role) {
  writeRaw(KEYS[role], null);
  emit();
}

/** 閲覧用APIで使うトークン（管理者トークンは閲覧権限も持つ） */
export function viewerCapableToken(): string | null {
  return getToken("admin") ?? getToken("viewer");
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn();
}
