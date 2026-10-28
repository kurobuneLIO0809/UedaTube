// Workers KV への保存（塊への分割・容量と回数の上限・有効期限）のテスト
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { RETENTION_MS } from "../../shared/constants";
import { buildMp4 } from "../../shared/testing/mp4fixture";
import { runCleanup } from "../src/cleanup";
import { chunkTtlSeconds, utcDay } from "../src/storage";
import { call, chunkKeyOf, login, seedVideo, thumbKeyOf } from "./helpers";

const MIB = 1024 * 1024;
const today = () => utcDay(Date.now());

async function setOps(op: "write" | "delete" | "list", count: number) {
  await env.DB.prepare(
    "INSERT INTO kv_daily_ops (day, op, count) VALUES (?1, ?2, ?3) ON CONFLICT (day, op) DO UPDATE SET count = ?3",
  )
    .bind(today(), op, count)
    .run();
}

async function streamPath(id: string) {
  const viewer = await login("viewer");
  const d = (await (await call(`/api/videos/${id}`, { token: viewer })).json()) as { video: { streamUrl: string } };
  const u = new URL(d.video.streamUrl);
  return u.pathname + u.search;
}

function meta(size: number) {
  return { title: "KVテスト", category: "授業", fileName: "a.mp4", fileSize: size, contentType: "video/mp4" };
}

afterEach(async () => {
  // 他のテストに影響しないよう、操作回数の記録と予約用の行を戻す
  await env.DB.prepare("DELETE FROM kv_daily_ops").run();
  await env.DB.prepare("DELETE FROM videos WHERE title = '容量予約'").run();
});

describe("塊に分けた動画の配信", () => {
  it("Range が塊の境目をまたぐ場合は、塊の終わりまでを 206 で返し、続きは次の要求で返す", async () => {
    const bytes = buildMp4({ mdatBytes: Math.floor(2.5 * MIB) });
    const v = await seedVideo({ bytes, partSize: MIB });
    const path = await streamPath(v.id);

    const r1 = await call(path, { headers: { Range: `bytes=${MIB - 100}-${MIB + 99}` } });
    expect(r1.status).toBe(206);
    expect(r1.headers.get("Content-Range")).toBe(`bytes ${MIB - 100}-${MIB - 1}/${bytes.length}`);
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(bytes.slice(MIB - 100, MIB));

    const r2 = await call(path, { headers: { Range: `bytes=${MIB}-${MIB + 99}` } });
    expect(r2.status).toBe(206);
    expect(new Uint8Array(await r2.arrayBuffer())).toEqual(bytes.slice(MIB, MIB + 100));

    // 末尾からの指定
    const r3 = await call(path, { headers: { Range: "bytes=-50" } });
    expect(new Uint8Array(await r3.arrayBuffer())).toEqual(bytes.slice(-50));
  });

  it("Range なしの要求には、すべての塊を順につなげて返す", async () => {
    const bytes = buildMp4({ mdatBytes: Math.floor(2.5 * MIB) });
    const v = await seedVideo({ bytes, partSize: MIB });
    const res = await call(await streamPath(v.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(bytes.length);
    expect(got.slice(MIB * 2 - 10, MIB * 2 + 10)).toEqual(bytes.slice(MIB * 2 - 10, MIB * 2 + 10));
  });

  it("公開直後に塊がまだ見つからない場合は 503（再試行）、時間が経っていれば 404", async () => {
    const v = await seedVideo();
    const path = await streamPath(v.id);
    await env.MEDIA.delete(chunkKeyOf(v.id, 0));
    const soon = await call(path, { headers: { Range: "bytes=0-99" } });
    expect(soon.status).toBe(503);
    expect(soon.headers.get("Retry-After")).toBe("5");
    await env.DB.prepare("UPDATE videos SET uploadedAt = ?2, expiresAt = ?3 WHERE id = ?1")
      .bind(v.id, Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000 + RETENTION_MS)
      .run();
    expect((await call(path, { headers: { Range: "bytes=0-99" } })).status).toBe(404);
  });
});

describe("無料プランの上限を超えない仕組み", () => {
  it("保存領域の残りが足りないとアップロードを始めない（507）", async () => {
    const admin = await login("admin");
    // 512MiB の上限のうち 510MiB を予約済みの状態にする
    await env.DB.prepare(
      `INSERT INTO videos (id, title, category, storageKey, fileSize, partSize, createdAt, status, updatedAt)
       VALUES (?1, '容量予約', '授業', ?2, ?3, ?4, ?5, 'uploading', ?5)`,
    )
      .bind(crypto.randomUUID(), `v/${crypto.randomUUID()}`, 510 * MIB, 5 * MIB, Date.now())
      .run();
    const res = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(3 * MIB) });
    expect(res.status).toBe(507);
    const err = ((await res.json()) as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("STORAGE_FULL");
    expect(err.message).toContain("上限");
  });

  it("今日の KV 書き込み回数の残りが足りないとアップロードを始めない（429）", async () => {
    const admin = await login("admin");
    await setOps("write", 899);
    const res = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(3 * MIB) });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("KV_DAILY_LIMIT");
  });

  it("アップロードの書き込み回数を数える", async () => {
    const admin = await login("admin");
    const bytes = buildMp4({ mdatBytes: 6 * MIB }); // 5MiB の塊 2つ
    const start = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(bytes.length) });
    const { videoId, partSize, partCount } = (await start.json()) as { videoId: string; partSize: number; partCount: number };
    expect(partCount).toBe(2);
    for (let n = 1; n <= partCount; n++) {
      const chunk = bytes.slice((n - 1) * partSize, n * partSize);
      const r = await call(`/api/admin/videos/${videoId}/parts/${n}`, { method: "PUT", token: admin, body: chunk, headers: { "Content-Length": String(chunk.length) } });
      expect(r.status).toBe(200);
    }
    const row = await env.DB.prepare("SELECT count FROM kv_daily_ops WHERE day = ?1 AND op = 'write'").bind(today()).first<{ count: number }>();
    expect(row?.count).toBe(2);
    expect((await call(`/api/admin/videos/${videoId}/complete`, { method: "POST", token: admin, json: {} })).status).toBe(200);
  });

  it("保存した塊とサムネイルには有効期限を付ける（定期削除が止まっても KV から消える）", async () => {
    const admin = await login("admin");
    const bytes = buildMp4({ mdatBytes: 4096 });
    const start = await call("/api/admin/videos", { method: "POST", token: admin, json: meta(bytes.length) });
    const { videoId } = (await start.json()) as { videoId: string };
    await call(`/api/admin/videos/${videoId}/parts/1`, { method: "PUT", token: admin, body: bytes, headers: { "Content-Length": String(bytes.length) } });
    await call(`/api/admin/videos/${videoId}/complete`, { method: "POST", token: admin, json: {} });
    await call(`/api/admin/videos/${videoId}/thumbnail`, { method: "PUT", token: admin, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1]), headers: { "Content-Type": "image/jpeg" } });
    const list = await env.MEDIA.list({ prefix: `v/${videoId}/` });
    expect(list.keys.map((k) => k.name).sort()).toEqual([chunkKeyOf(videoId, 0), thumbKeyOf(videoId)].sort());
    const nowSec = Date.now() / 1000;
    for (const k of list.keys) {
      expect(k.expiration).toBeDefined();
      // 14日＋1日（アップロード猶予）＋1日 以内に消える
      expect(k.expiration! - nowSec).toBeLessThanOrEqual(chunkTtlSeconds() + 5);
      expect(k.expiration! - nowSec).toBeGreaterThan(14 * 24 * 3600);
    }
  });

  it("KV の削除回数が足りない日は視聴不可のまま残し、翌日以降に削除する", async () => {
    const v = await seedVideo({ thumbnail: true });
    const uploadedAt = Date.now() - RETENTION_MS - 60_000;
    await env.DB.prepare("UPDATE videos SET uploadedAt = ?2, expiresAt = ?3 WHERE id = ?1").bind(v.id, uploadedAt, uploadedAt + RETENTION_MS).run();
    await setOps("delete", 900);
    const first = await runCleanup(env, Date.now());
    expect(first.failedVideos).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("SELECT status FROM videos WHERE id = ?1").bind(v.id).first<{ status: string }>();
    expect(row?.status).toBe("deleting");
    expect(await env.MEDIA.get(chunkKeyOf(v.id, 0))).not.toBeNull();
    // 翌日（回数が戻った後）
    await env.DB.prepare("DELETE FROM kv_daily_ops").run();
    const second = await runCleanup(env, Date.now());
    expect(second.failedVideos).toBe(0);
    expect(await env.MEDIA.get(chunkKeyOf(v.id, 0))).toBeNull();
    expect(await env.MEDIA.get(thumbKeyOf(v.id))).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM videos WHERE id = ?1").bind(v.id).first()).toBeNull();
  });

  it("管理ダッシュボードで保存領域と今日の操作回数を確認できる", async () => {
    const admin = await login("admin");
    await seedVideo();
    await setOps("write", 12);
    const d = (await (await call("/api/admin/dashboard", { token: admin })).json()) as {
      kv: { usedBytes: number; limitBytes: number; opsToday: { write: number }; opsLimits: { write: number } };
      limits: { availableBytes: number };
    };
    expect(d.kv.usedBytes).toBeGreaterThan(0);
    expect(d.kv.limitBytes).toBe(512 * MIB);
    expect(d.kv.opsToday.write).toBe(12);
    expect(d.kv.opsLimits.write).toBe(900);
    expect(d.limits.availableBytes).toBeLessThanOrEqual(64 * MIB);
  });
});
