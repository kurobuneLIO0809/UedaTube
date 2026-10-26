import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RETENTION_MS } from "../../shared/constants";
import { buildMp4, type FixtureOptions } from "../../shared/testing/mp4fixture";
import { call, login } from "./helpers";

const PART = 5 * 1024 * 1024;

function meta(bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return { title: "アップロードテスト", description: "説明", category: "授業", fileName: "movie.mp4", fileSize: bytes.length, contentType: "video/mp4", ...extra };
}

async function upload(token: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  const start = await call("/api/admin/videos", { method: "POST", token, json: meta(bytes, extra) });
  if (start.status !== 201) return { start, complete: null, videoId: null };
  const { videoId, partSize, partCount } = (await start.json()) as { videoId: string; partSize: number; partCount: number };
  const parts: { partNumber: number; etag: string }[] = [];
  for (let n = 1; n <= partCount; n++) {
    const chunk = bytes.slice((n - 1) * partSize, n * partSize);
    const r = await call(`/api/admin/videos/${videoId}/parts/${n}`, {
      method: "PUT",
      token,
      body: chunk,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.length) },
    });
    expect(r.status).toBe(200);
    parts.push((await r.json()) as { partNumber: number; etag: string });
  }
  const complete = await call(`/api/admin/videos/${videoId}/complete`, { method: "POST", token, json: { parts } });
  return { start, complete, videoId };
}

async function digest(b: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b)), (x) => x.toString(16).padStart(2, "0")).join("");
}

function mp4(opts: FixtureOptions) {
  return buildMp4({ mdatBytes: 2048, ...opts });
}

describe("動画アップロード", () => {
  it("管理者以外のアップロードを拒否する", async () => {
    const viewer = await login("viewer");
    const bytes = mp4({});
    expect((await call("/api/admin/videos", { method: "POST", json: meta(bytes) })).status).toBe(401);
    expect((await call("/api/admin/videos", { method: "POST", token: viewer, json: meta(bytes) })).status).toBe(403);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE title = 'アップロードテスト'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("複数パートに分割したMP4をアップロードし、14日後の削除予定日時を設定する", async () => {
    const admin = await login("admin");
    // 5MiB × 2 + α の動画（moov を末尾に置いた非faststartファイル）
    const bytes = mp4({ width: 1280, height: 720, durationSeconds: 125.5, mdatBytes: PART * 2 + 1234, moovAtEnd: true });
    const before = Date.now();
    const { complete, videoId } = await upload(admin, bytes);
    expect(complete!.status).toBe(200);
    const v = ((await complete!.json()) as { video: Record<string, unknown> }).video;
    expect(v).toMatchObject({ status: "published", width: 1280, height: 720, durationSeconds: 125.5 });
    const row = await env.DB.prepare("SELECT * FROM videos WHERE id = ?1").bind(videoId).first<{ uploadedAt: number; expiresAt: number; uploadId: string | null }>();
    expect(row!.uploadedAt).toBeGreaterThanOrEqual(before);
    expect(row!.expiresAt - row!.uploadedAt).toBe(RETENTION_MS);
    expect(row!.uploadId).toBeNull();
    const obj = await env.BUCKET.get(`videos/${videoId}/video.mp4`);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(stored.length).toBe(bytes.length);
    expect(await digest(stored)).toBe(await digest(bytes));
  });

  it("縦長の720×1280は受け付ける", async () => {
    const admin = await login("admin");
    const { complete } = await upload(admin, mp4({ width: 720, height: 1280 }));
    expect(complete!.status).toBe(200);
  });

  it("720pを超える動画を拒否し、R2にファイルを残さない", async () => {
    const admin = await login("admin");
    for (const [width, height] of [[1920, 1080], [1281, 720], [1280, 721]]) {
      const { complete, videoId } = await upload(admin, mp4({ width, height }));
      expect(complete!.status).toBe(422);
      const err = ((await complete!.json()) as { error: { code: string; message: string } }).error;
      expect(err.code).toBe("RESOLUTION_TOO_HIGH");
      expect(err.message).toContain(`${width}×${height}`);
      expect(await env.BUCKET.head(`videos/${videoId}/video.mp4`)).toBeNull();
      const row = await env.DB.prepare("SELECT status, failureReason FROM videos WHERE id = ?1").bind(videoId).first<{ status: string; failureReason: string }>();
      expect(row!.status).toBe("failed");
      expect(row!.failureReason).toContain("720p");
    }
  });

  it("対応していない動画形式を拒否する", async () => {
    const admin = await login("admin");
    // 拡張子・Content-Type が MP4 でない
    expect((await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({}), { contentType: "video/webm" }) })).status).toBe(400);
    expect((await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({}), { fileName: "movie.mov" }) })).status).toBe(400);

    // 中身が MP4 でない（WebM のシグネチャ）
    const webm = new Uint8Array(4096);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    const r1 = await upload(admin, webm);
    expect(r1.complete!.status).toBe(422);
    expect(((await r1.complete!.json()) as { error: { code: string } }).error.code).toBe("NOT_MP4");

    // H.265 の MP4
    const r2 = await upload(admin, mp4({ videoCodec: "hvc1" }));
    expect(((await r2.complete!.json()) as { error: { code: string } }).error.code).toBe("UNSUPPORTED_VIDEO_CODEC");

    // QuickTime
    const r3 = await upload(admin, mp4({ majorBrand: "qt  " }));
    expect(((await r3.complete!.json()) as { error: { code: string } }).error.code).toBe("QUICKTIME");
  });

  it("ファイルサイズの上限を超える場合はアップロードを開始しない", async () => {
    const admin = await login("admin");
    const res = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({}), { fileSize: 65 * 1024 * 1024 }) });
    expect(res.status).toBe(400);
  });

  it("パートの大きさが不正な場合は拒否する", async () => {
    const admin = await login("admin");
    const bytes = mp4({ mdatBytes: PART + 10 });
    const start = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(bytes) });
    const { videoId } = (await start.json()) as { videoId: string };
    const r = await call(`/api/admin/videos/${videoId}/parts/1`, { method: "PUT", token: admin, body: new Uint8Array(100), headers: { "Content-Length": "100" } });
    expect(r.status).toBe(400);
    expect((await call(`/api/admin/videos/${videoId}/parts/3`, { method: "PUT", token: admin, body: new Uint8Array(10) })).status).toBe(400);
  });

  it("アップロードのキャンセル（削除）でR2とD1に何も残らない", async () => {
    const admin = await login("admin");
    const bytes = mp4({ mdatBytes: PART + 10 });
    const start = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(bytes) });
    const { videoId } = (await start.json()) as { videoId: string };
    const chunk = bytes.slice(0, PART);
    await call(`/api/admin/videos/${videoId}/parts/1`, { method: "PUT", token: admin, body: chunk, headers: { "Content-Length": String(PART) } });
    const del = await call(`/api/admin/videos/${videoId}`, { method: "DELETE", token: admin });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare("SELECT id FROM videos WHERE id = ?1").bind(videoId).first()).toBeNull();
    expect(await env.BUCKET.head(`videos/${videoId}/video.mp4`)).toBeNull();
  });

  it("サムネイルは画像の中身を検査して保存する", async () => {
    const admin = await login("admin");
    const { videoId } = await upload(admin, mp4({}));
    const fake = await call(`/api/admin/videos/${videoId}/thumbnail`, { method: "PUT", token: admin, body: "<svg onload=alert(1)>", headers: { "Content-Type": "image/png" } });
    expect(fake.status).toBe(415);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    const ok = await call(`/api/admin/videos/${videoId}/thumbnail`, { method: "PUT", token: admin, body: jpeg, headers: { "Content-Type": "image/jpeg" } });
    expect(ok.status).toBe(200);
    const viewer = await login("viewer");
    const d = (await (await call(`/api/videos/${videoId}`, { token: viewer })).json()) as { video: { thumbnailUrl: string } };
    const u = new URL(d.video.thumbnailUrl);
    const img = await call(u.pathname + u.search);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("公開前の確認用に非公開でアップロードし、後から公開できる", async () => {
    const admin = await login("admin");
    const viewer = await login("viewer");
    const { complete, videoId } = await upload(admin, mp4({}), { publish: false });
    expect(((await complete!.json()) as { video: { status: string } }).video.status).toBe("hidden");
    expect((await call(`/api/videos/${videoId}`, { token: viewer })).status).toBe(404);
    const p = await call(`/api/admin/videos/${videoId}`, { method: "PATCH", token: admin, json: { status: "published", title: "新しいタイトル" } });
    expect(p.status).toBe(200);
    const d = (await (await call(`/api/videos/${videoId}`, { token: viewer })).json()) as { video: { title: string } };
    expect(d.video.title).toBe("新しいタイトル");
  });

  it("保存済みファイルの検査ができる", async () => {
    const admin = await login("admin");
    const { videoId } = await upload(admin, mp4({ width: 640, height: 360 }));
    const r = (await (await call(`/api/admin/videos/${videoId}/inspect`, { method: "POST", token: admin })).json()) as { ok: boolean };
    expect(r.ok).toBe(true);
    await env.BUCKET.delete(`videos/${videoId}/video.mp4`);
    const r2 = (await (await call(`/api/admin/videos/${videoId}/inspect`, { method: "POST", token: admin })).json()) as { ok: boolean };
    expect(r2.ok).toBe(false);
  });
});

describe("自動変換に関するサーバー側の保証", () => {
  it("変換済みとして申告されても、実ファイルが720pを超えていれば保存しない（ブラウザ側だけの偽装を防ぐ）", async () => {
    const admin = await login("admin");
    const bytes = mp4({ width: 1920, height: 1080 });
    const { complete, videoId } = await upload(admin, bytes, { source: { width: 1920, height: 1080, codec: "h264", transcoded: true } });
    expect(complete!.status).toBe(422);
    expect(await env.BUCKET.head(`videos/${videoId}/video.mp4`)).toBeNull();
    const row = await env.DB.prepare("SELECT status FROM videos WHERE id = ?1").bind(videoId).first<{ status: string }>();
    expect(row!.status).toBe("failed");
    // 公開されない
    const viewer = await login("viewer");
    expect((await call(`/api/videos/${videoId}`, { token: viewer })).status).toBe(404);
  });

  it("変換後の動画と元動画の情報を区別して記録する", async () => {
    const admin = await login("admin");
    const { complete, videoId } = await upload(admin, mp4({ width: 1280, height: 720 }), {
      source: { width: 1920, height: 1080, codec: "hevc", transcoded: true },
    });
    expect(complete!.status).toBe(200);
    const v = (await (await call(`/api/admin/videos/${videoId}`, { token: admin })).json()) as {
      video: { width: number; height: number; videoCodec: string; source: Record<string, unknown> };
    };
    // 保存されている（サーバーが検査した）動画
    expect([v.video.width, v.video.height, v.video.videoCodec]).toEqual([1280, 720, "avc1"]);
    // 元動画の参考情報
    expect(v.video.source).toEqual({ width: 1920, height: 1080, codec: "hevc", transcoded: true });
  });

  it("元動画の情報に不正な値があれば拒否する", async () => {
    const admin = await login("admin");
    const bad = [{ width: -1 }, { width: 1.5 }, { codec: "<script>" }, { transcoded: "yes" }, "string"];
    for (const source of bad) {
      const r = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({}), { source }) });
      expect(r.status, JSON.stringify(source)).toBe(400);
    }
  });

  it("同時に進行できるアップロード数を制限する", async () => {
    const admin = await login("admin");
    // 他のテストで残った進行中のアップロードを片付ける
    await env.DB.prepare("DELETE FROM videos WHERE status = 'uploading'").run();
    const started: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({})) });
      expect(r.status).toBe(201);
      started.push(((await r.json()) as { videoId: string }).videoId);
    }
    const over = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({})) });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("TOO_MANY_UPLOADS");
    // 1件中止すると再び開始できる
    await call(`/api/admin/videos/${started[0]}`, { method: "DELETE", token: admin });
    expect((await call("/api/admin/videos", { method: "POST", token: admin, json: meta(mp4({})) })).status).toBe(201);
  });
});
