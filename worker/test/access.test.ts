import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, freshIp, login, ORIGIN } from "./helpers";

describe("合言葉によるアクセス制御", () => {
  it("間違った閲覧用合言葉を拒否する", async () => {
    const res = await call("/api/access/verify", { method: "POST", json: { passphrase: "wrong-passphrase" }, ip: freshIp() });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string }; token?: string };
    expect(body.error.code).toBe("WRONG_PASSPHRASE");
    expect(body.token).toBeUndefined();
  });

  it("正しい閲覧用合言葉で閲覧用トークンを発行する（合言葉そのものは返さない）", async () => {
    const res = await call("/api/access/verify", { method: "POST", json: { passphrase: env.VIEWER_PASSPHRASE }, ip: freshIp() });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(env.VIEWER_PASSPHRASE!);
    const body = JSON.parse(text) as { token: string; role: string; expiresAt: string };
    expect(body.role).toBe("viewer");
    expect(body.token).toMatch(/^v1\./);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("閲覧用合言葉では管理者トークンを得られない", async () => {
    const res = await call("/api/admin/verify", { method: "POST", json: { passphrase: env.VIEWER_PASSPHRASE }, ip: freshIp() });
    expect(res.status).toBe(401);
  });

  it("間違った管理者用合言葉を拒否する", async () => {
    const res = await call("/api/admin/verify", { method: "POST", json: { passphrase: "not-the-admin" }, ip: freshIp() });
    expect(res.status).toBe(401);
  });

  it("正しい管理者用合言葉で管理者トークンを発行する", async () => {
    const res = await call("/api/admin/verify", { method: "POST", json: { passphrase: env.ADMIN_PASSPHRASE }, ip: freshIp() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });

  it("閲覧用トークンで管理者専用APIを実行できない", async () => {
    const viewer = await login("viewer");
    const targets: [string, string, unknown?][] = [
      ["GET", "/api/admin/dashboard"],
      ["GET", "/api/admin/videos"],
      ["POST", "/api/admin/videos", { title: "x", category: "授業", fileName: "a.mp4", fileSize: 100, contentType: "video/mp4" }],
      ["DELETE", `/api/admin/videos/${crypto.randomUUID()}`],
      ["PATCH", `/api/admin/videos/${crypto.randomUUID()}`, { status: "published" }],
      ["DELETE", "/api/admin/comments/1"],
      ["POST", "/api/admin/cleanup"],
    ];
    for (const [method, path, json] of targets) {
      const res = await call(path, { method, token: viewer, ...(json ? { json } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("トークンなし・改ざんされたトークンを拒否する", async () => {
    expect((await call("/api/videos")).status).toBe(401);
    const viewer = await login("viewer");
    const [v, payload, sig] = viewer.split(".");
    // 役割を admin に書き換えたトークン（署名が一致しない）
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))), role: "admin" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await call("/api/admin/dashboard", { token: `${v}.${forged}.${sig}` });
    expect(res.status).toBe(401);
  });

  it("期限切れトークンを拒否する", async () => {
    const viewer = await login("viewer");
    const realNow = Date.now;
    try {
      // 9時間後（閲覧用トークンの有効期間8時間を過ぎた時刻）
      Date.now = () => realNow() + 9 * 3600 * 1000;
      const res = await call("/api/videos", { token: viewer });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_TOKEN");
    } finally {
      Date.now = realNow;
    }
    expect((await call("/api/videos", { token: viewer })).status).toBe(200);
  });

  it("連続して間違えると一時的に制限する", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      const r = await call("/api/admin/verify", { method: "POST", json: { passphrase: `wrong-${i}` }, ip });
      expect(r.status).toBe(401);
    }
    // 正しい合言葉でも制限中は拒否
    const blocked = await call("/api/admin/verify", { method: "POST", json: { passphrase: env.ADMIN_PASSPHRASE }, ip });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("CORSは許可したオリジンにだけ応答する", async () => {
    const ok = await call("/api/videos", { method: "OPTIONS", headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const ng = await call("/api/videos", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(ng.status).toBe(403);
    expect(ng.headers.get("Access-Control-Allow-Origin")).toBeNull();
    // 許可外オリジンからの書き込みは拒否
    const post = await call("/api/access/verify", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      json: { passphrase: env.VIEWER_PASSPHRASE },
      ip: freshIp(),
    });
    expect(post.status).toBe(403);
  });
});
