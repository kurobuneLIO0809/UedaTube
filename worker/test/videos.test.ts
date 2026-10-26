import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RETENTION_MS } from "../../shared/constants";
import { call, login, seedVideo } from "./helpers";

interface VideoJson {
  id: string;
  title: string;
  streamUrl: string;
  thumbnailUrl: string | null;
  expiresAt: string;
  uploadedAt: string;
  commentCount: number;
}

async function detail(id: string, token: string) {
  const res = await call(`/api/videos/${id}`, { token });
  return { res, body: res.status === 200 ? ((await res.json()) as { video: VideoJson }).video : null };
}

function pathOf(url: string) {
  const u = new URL(url);
  return u.pathname + u.search;
}

describe("動画一覧・詳細", () => {
  it("公開中の動画だけを一覧に表示し、期限切れ・非公開は表示しない", async () => {
    const viewer = await login("viewer");
    const live = await seedVideo({ title: "公開中の動画" });
    const expired = await seedVideo({ title: "期限切れの動画", uploadedAt: Date.now() - RETENTION_MS - 1000 });
    const hidden = await seedVideo({ title: "非公開の動画", status: "hidden" });
    const res = await call("/api/videos", { token: viewer });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const ids = ((await res.json()) as { videos: VideoJson[] }).videos.map((v) => v.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(hidden.id);
  });

  it("タイトル検索とカテゴリ絞り込み", async () => {
    const viewer = await login("viewer");
    const a = await seedVideo({ title: "理科の実験 100%", category: "授業" });
    const b = await seedVideo({ title: "体育祭ダイジェスト", category: "行事" });
    const search = (await (await call(`/api/videos?q=${encodeURIComponent("実験 100%")}`, { token: viewer })).json()) as { videos: VideoJson[] };
    expect(search.videos.map((v) => v.id)).toEqual([a.id]);
    const cat = (await (await call(`/api/videos?category=${encodeURIComponent("行事")}`, { token: viewer })).json()) as {
      videos: VideoJson[];
      categories: string[];
    };
    expect(cat.videos.map((v) => v.id)).toContain(b.id);
    expect(cat.videos.map((v) => v.id)).not.toContain(a.id);
    expect(cat.categories).toEqual(expect.arrayContaining(["授業", "行事"]));
  });

  it("削除予定日時はアップロードから14日後（UTC）", async () => {
    const viewer = await login("viewer");
    const uploadedAt = Date.UTC(2026, 9, 20, 3, 0, 0);
    // 期限内に見えるよう、現在時刻を固定
    const realNow = Date.now;
    Date.now = () => uploadedAt + 1000;
    try {
      const v = await seedVideo({ uploadedAt });
      const { body } = await detail(v.id, viewer);
      expect(body!.uploadedAt).toBe("2026-10-20T03:00:00.000Z");
      expect(body!.expiresAt).toBe("2026-11-03T03:00:00.000Z");
    } finally {
      Date.now = realNow;
    }
  });

  it("期限切れの動画は詳細も取得できない（410）", async () => {
    const admin = await login("admin");
    const v = await seedVideo({ uploadedAt: Date.now() - RETENTION_MS - 1 });
    const { res } = await detail(v.id, admin);
    expect(res.status).toBe(410);
  });

  it("非公開の動画は閲覧者には見えず、管理者は確認できる", async () => {
    const v = await seedVideo({ status: "hidden" });
    expect((await detail(v.id, await login("viewer"))).res.status).toBe(404);
    expect((await detail(v.id, await login("admin"))).res.status).toBe(200);
  });

  it("動画メタデータAPIは認証済みユーザーだけが利用できる", async () => {
    const v = await seedVideo();
    expect((await call(`/api/videos/${v.id}`)).status).toBe(401);
    expect((await call(`/api/videos/${v.id}/comments`)).status).toBe(401);
  });
});

describe("動画配信（Range対応）", () => {
  it("Rangeリクエストで指定範囲を206で返す（シーク再生）", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const { body } = await detail(v.id, viewer);
    const path = pathOf(body!.streamUrl);

    const full = await call(path);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Cache-Control")).toContain("no-store");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(v.bytes);

    const partial = await call(path, { headers: { Range: "bytes=1000-1999" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe(`bytes 1000-1999/${v.bytes.length}`);
    expect(partial.headers.get("Content-Length")).toBe("1000");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(v.bytes.slice(1000, 2000));

    const open = await call(path, { headers: { Range: "bytes=40000-" } });
    expect(open.status).toBe(206);
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(v.bytes.slice(40000));

    const suffix = await call(path, { headers: { Range: "bytes=-100" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(v.bytes.slice(-100));

    const bad = await call(path, { headers: { Range: `bytes=${v.bytes.length + 10}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${v.bytes.length}`);

    const head = await call(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(v.bytes.length));
  });

  it("視聴URLのトークンがない・別の動画用・期限切れの場合は配信しない", async () => {
    const viewer = await login("viewer");
    const a = await seedVideo();
    const b = await seedVideo();
    const { body } = await detail(a.id, viewer);
    const token = new URL(body!.streamUrl).searchParams.get("st");
    expect((await call(`/api/videos/${a.id}/stream`)).status).toBe(401);
    // セッショントークンを視聴URLに流用することはできない
    expect((await call(`/api/videos/${a.id}/stream?st=${viewer}`)).status).toBe(401);
    expect((await call(`/api/videos/${b.id}/stream?st=${token}`)).status).toBe(401);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 16 * 60 * 1000;
      expect((await call(`/api/videos/${a.id}/stream?st=${token}`)).status).toBe(401);
    } finally {
      Date.now = realNow;
    }
  });

  it("期限切れ動画はR2にファイルが残っていても視聴できない（Cronが止まっていても有効）", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo({ thumbnail: true });
    const { body } = await detail(v.id, viewer);
    // 視聴URL発行後に期限が来た場合
    await env.DB.prepare("UPDATE videos SET uploadedAt = ?2, expiresAt = ?3 WHERE id = ?1")
      .bind(v.id, Date.now() - RETENTION_MS - 1, Date.now() - 1)
      .run();
    expect(await env.BUCKET.head(`videos/${v.id}/video.mp4`)).not.toBeNull();
    const res = await call(pathOf(body!.streamUrl), { headers: { Range: "bytes=0-99" } });
    expect(res.status).toBe(410);
    expect((await call(pathOf(body!.thumbnailUrl!))).status).toBe(410);
    expect((await call(`/api/videos/${v.id}/playback`, { token: viewer })).status).toBe(410);
    expect((await call(`/api/videos/${v.id}/comments`, { token: viewer })).status).toBe(410);
  });

  it("期限切れの動画を再公開できない", async () => {
    const admin = await login("admin");
    const v = await seedVideo({ status: "hidden", uploadedAt: Date.now() - RETENTION_MS - 1 });
    const res = await call(`/api/admin/videos/${v.id}`, { method: "PATCH", token: admin, json: { status: "published" } });
    expect(res.status).toBe(410);
    const row = await env.DB.prepare("SELECT status FROM videos WHERE id = ?1").bind(v.id).first<{ status: string }>();
    expect(row?.status).toBe("hidden");
  });
});
