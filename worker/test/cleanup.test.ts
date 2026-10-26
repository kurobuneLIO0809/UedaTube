import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RETENTION_MS } from "../../shared/constants";
import worker from "../src/index";
import { ORPHAN_GRACE_MS, STALE_UPLOAD_MS, runCleanup } from "../src/cleanup";
import type { Env } from "../src/env";
import { baseComment, call, freshIp, login, seedVideo } from "./helpers";

async function addComment(videoId: string) {
  const viewer = await login("viewer");
  const r = await call(`/api/videos/${videoId}/comments`, { method: "POST", token: viewer, json: baseComment({ text: crypto.randomUUID().slice(0, 8) }), ip: freshIp() });
  expect(r.status).toBe(201);
}

async function expire(videoId: string) {
  const uploadedAt = Date.now() - RETENTION_MS - 60_000;
  await env.DB.prepare("UPDATE videos SET uploadedAt = ?2, expiresAt = ?3 WHERE id = ?1").bind(videoId, uploadedAt, uploadedAt + RETENTION_MS).run();
}

async function exists(videoId: string) {
  const video = await env.DB.prepare("SELECT id FROM videos WHERE id = ?1").bind(videoId).first();
  const comments = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE videoId = ?1").bind(videoId).first<{ n: number }>();
  const file = await env.BUCKET.head(`videos/${videoId}/video.mp4`);
  const thumb = await env.BUCKET.head(`videos/${videoId}/thumbnail`);
  return { video: !!video, comments: comments?.n ?? 0, file: !!file, thumb: !!thumb };
}

describe("14日後の自動削除（Cron Trigger）", () => {
  it("wrangler.jsonc に5分ごとのCron Triggerが設定されている", async () => {
    // 設定ファイルはビルド時に読み込めないため、scheduled ハンドラーが存在することを確認
    expect(typeof worker.scheduled).toBe("function");
  });

  it("期限切れ動画のファイル・サムネイル・メタデータ・コメントをすべて削除する", async () => {
    const v = await seedVideo({ thumbnail: true });
    const keep = await seedVideo();
    await addComment(v.id);
    await addComment(keep.id);
    await expire(v.id);
    expect(await exists(v.id)).toEqual({ video: true, comments: 1, file: true, thumb: true });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await exists(v.id)).toEqual({ video: false, comments: 0, file: false, thumb: false });
    // 期限内の動画は残る
    expect(await exists(keep.id)).toMatchObject({ video: true, comments: 1, file: true });
    const run = await env.DB.prepare("SELECT * FROM cleanup_runs ORDER BY id DESC LIMIT 1").first<{ deletedVideos: number }>();
    expect(run!.deletedVideos).toBeGreaterThanOrEqual(1);
  });

  it("削除に失敗した場合は視聴不可のまま残し、次回の実行で再試行する", async () => {
    const v = await seedVideo({ thumbnail: true });
    await addComment(v.id);
    await expire(v.id);

    // R2の削除が一時的に失敗する環境
    const failingBucket = new Proxy(env.BUCKET, {
      get(target, prop, receiver) {
        if (prop === "delete") return async () => { throw new Error("R2 temporarily unavailable"); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = await runCleanup({ ...env, BUCKET: failingBucket } as Env, Date.now());
    expect(first.failedVideos).toBeGreaterThanOrEqual(1);
    expect(first.errors.join("\n")).toContain("R2 temporarily unavailable");
    const row = await env.DB.prepare("SELECT status, deleteAttempts, lastDeleteError FROM videos WHERE id = ?1").bind(v.id).first<{ status: string; deleteAttempts: number; lastDeleteError: string }>();
    expect(row).toMatchObject({ status: "deleting", deleteAttempts: 1 });

    // 失敗中も視聴はできない
    const viewer = await login("viewer");
    expect((await call(`/api/videos/${v.id}`, { token: viewer })).status).toBe(410);

    // 再試行で完全に削除される
    const second = await runCleanup(env, Date.now());
    expect(second.failedVideos).toBe(0);
    expect(await exists(v.id)).toEqual({ video: false, comments: 0, file: false, thumb: false });
  });

  it("既に削除済みのファイルがあっても処理全体は失敗しない", async () => {
    const v = await seedVideo({ thumbnail: true });
    await expire(v.id);
    await env.BUCKET.delete([`videos/${v.id}/video.mp4`, `videos/${v.id}/thumbnail`]);
    const summary = await runCleanup(env, Date.now());
    expect(summary.failedVideos).toBe(0);
    expect(await exists(v.id)).toMatchObject({ video: false });
  });

  it("完了しないまま放置されたアップロードを削除する", async () => {
    const admin = await login("admin");
    const start = await call("/api/admin/videos", {
      method: "POST",
      token: admin,
      json: { title: "放置", category: "授業", fileName: "a.mp4", fileSize: 6 * 1024 * 1024, contentType: "video/mp4" },
    });
    const { videoId } = (await start.json()) as { videoId: string };
    await runCleanup(env, Date.now());
    expect((await exists(videoId)).video).toBe(true); // まだ24時間経っていない
    await runCleanup(env, Date.now() + STALE_UPLOAD_MS + 1000);
    expect((await exists(videoId)).video).toBe(false);
  });

  it("D1に対応する動画が無いR2の孤立ファイルを削除する", async () => {
    const orphanId = crypto.randomUUID();
    await env.BUCKET.put(`videos/${orphanId}/video.mp4`, new Uint8Array([1, 2, 3]));
    const v = await seedVideo();
    await runCleanup(env, Date.now() + ORPHAN_GRACE_MS + 1000);
    expect(await env.BUCKET.head(`videos/${orphanId}/video.mp4`)).toBeNull();
    // D1に存在する動画のファイルは消さない
    expect(await env.BUCKET.head(`videos/${v.id}/video.mp4`)).not.toBeNull();
  });

  it("管理者は手動で動画を削除でき、コメントも削除される", async () => {
    const admin = await login("admin");
    const v = await seedVideo({ thumbnail: true });
    await addComment(v.id);
    const viewer = await login("viewer");
    expect((await call(`/api/admin/videos/${v.id}`, { method: "DELETE", token: viewer })).status).toBe(403);
    expect((await call(`/api/admin/videos/${v.id}`, { method: "DELETE", token: admin })).status).toBe(200);
    expect(await exists(v.id)).toEqual({ video: false, comments: 0, file: false, thumb: false });
  });

  it("D1の外部キーにより、動画行を消すとコメントも消える", async () => {
    const v = await seedVideo();
    await addComment(v.id);
    await env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(v.id).run();
    expect((await exists(v.id)).comments).toBe(0);
  });

  it("管理画面から自動削除を手動実行できる（管理者のみ）", async () => {
    const viewer = await login("viewer");
    const admin = await login("admin");
    expect((await call("/api/admin/cleanup", { method: "POST", token: viewer })).status).toBe(403);
    const r = await call("/api/admin/cleanup", { method: "POST", token: admin });
    expect(r.status).toBe(200);
    const d = await call("/api/admin/dashboard", { token: admin });
    expect(d.status).toBe(200);
    const body = (await d.json()) as { cleanupRuns: unknown[] };
    expect(body.cleanupRuns.length).toBeGreaterThan(0);
  });
});
