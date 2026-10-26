import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { baseComment, call, freshIp, login, seedVideo } from "./helpers";

interface CommentJson {
  id: number;
  videoId: string;
  text: string;
  playbackTimeSeconds: number;
  color: string;
  fontSize: number;
  mode: string;
  xPercent: number;
  yPercent: number;
  isCommentArt: boolean;
  artLines: { text: string; color?: string; fontSize?: number }[] | null;
  nickname: string | null;
}

/**
 * コメントを投稿する。連投制限はブラウザのセッション単位なので、
 * sameSession=false（既定）の場合は投稿ごとに新しいセッションで投稿する（別々の生徒に相当）。
 */
async function post(videoId: string, token: string, body: unknown, ip = freshIp(), sameSession = false) {
  const t = sameSession ? token : await login("viewer");
  return call(`/api/videos/${videoId}/comments`, { method: "POST", token: t, json: body, ip });
}

async function list(videoId: string, token: string, after?: number) {
  const res = await call(`/api/videos/${videoId}/comments${after !== undefined ? `?after=${after}` : ""}`, { token });
  return (await res.json()) as { comments: CommentJson[]; latestId: number; total: number };
}

describe("コメントAPI", () => {
  it("コメントが正しい動画に保存され、再生位置が保存される", async () => {
    const viewer = await login("viewer");
    const a = await seedVideo();
    const b = await seedVideo();
    const res = await post(a.id, viewer, baseComment({ playbackTimeSeconds: 42.5, nickname: "  たろう " }));
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { comment: CommentJson }).comment;
    expect(created.videoId).toBe(a.id);
    expect(created.playbackTimeSeconds).toBe(42.5);
    expect(created.nickname).toBe("たろう");

    const la = await list(a.id, viewer);
    expect(la.comments.map((c) => c.text)).toEqual(["こんにちは"]);
    expect(la.comments[0].playbackTimeSeconds).toBe(42.5);
    // 別の動画には混在しない
    const lb = await list(b.id, viewer);
    expect(lb.comments).toHaveLength(0);

    // 別の閲覧者（別トークン）からも同じコメントが見える
    const other = await login("viewer");
    expect((await list(a.id, other)).comments).toHaveLength(1);
  });

  it("色・位置・サイズ・モードを保存し、空のニックネームはnullになる", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const res = await post(v.id, viewer, baseComment({ mode: "free", color: "#22d3ee", fontSize: 64, xPercent: 12.5, yPercent: 80, nickname: "" }));
    expect(res.status).toBe(201);
    const c = ((await res.json()) as { comment: CommentJson }).comment;
    expect(c).toMatchObject({ mode: "free", color: "#22D3EE", fontSize: 64, xPercent: 12.5, yPercent: 80, nickname: null });
  });

  it("差分取得（ポーリング）で新しいコメントだけ返す", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    await post(v.id, viewer, baseComment({ text: "1つめ" }));
    const first = await list(v.id, viewer);
    await post(v.id, viewer, baseComment({ text: "2つめ" }));
    const diff = await list(v.id, viewer, first.latestId);
    expect(diff.comments.map((c) => c.text)).toEqual(["2つめ"]);
  });

  it("コメントアートの改行・先頭の空白・行ごとの装飾を保持する", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const artLines = [
      { text: "   ∧＿∧" },
      { text: "  （ ´∀｀）", color: "#ff3b3b" },
      { text: "\t  ⊂　　）", fontSize: 30 },
      { text: "" },
      { text: "    END    " },
    ];
    const res = await post(v.id, viewer, baseComment({ isCommentArt: true, text: undefined, artLines, mode: "free", fontFamily: "mono", textAlign: "left" }));
    expect(res.status).toBe(201);
    const [c] = (await list(v.id, viewer)).comments;
    expect(c.isCommentArt).toBe(true);
    expect(c.text).toBe("   ∧＿∧\n  （ ´∀｀）\n\t  ⊂　　）\n\n    END    ");
    expect(c.artLines).toEqual([
      { text: "   ∧＿∧" },
      { text: "  （ ´∀｀）", color: "#FF3B3B" },
      { text: "\t  ⊂　　）", fontSize: 30 },
      { text: "" },
      { text: "    END    " },
    ]);
  });

  it("HTMLやスクリプトは文字列のまま保存し、JSONとして返す", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const xss = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const res = await post(v.id, viewer, baseComment({ text: xss }));
    expect(res.status).toBe(201);
    const r = await call(`/api/videos/${v.id}/comments`, { token: viewer });
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const [c] = ((await r.json()) as { comments: CommentJson[] }).comments;
    expect(c.text).toBe(xss);
  });

  it("不正な色・サイズ・位置・表示時間・モードを拒否する", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const bad = [
      { color: "red" },
      { color: "#FFF" },
      { color: "#FFFFFF; background:url(x)" },
      { fontSize: 11 },
      { fontSize: 97 },
      { fontSize: 24.5 },
      { xPercent: -1 },
      { yPercent: 101 },
      { durationSeconds: 0.5 },
      { durationSeconds: 11 },
      { mode: "marquee" },
      { fontFamily: "Comic Sans" },
      { opacity: 0 },
      { playbackTimeSeconds: -1 },
      { playbackTimeSeconds: 61.5 }, // 動画の長さ(60秒)を超える
      { text: "" },
      { text: "あ".repeat(76) },
      { text: "1行目\n2行目" },
    ];
    for (const extra of bad) {
      const res = await post(v.id, viewer, baseComment(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    // 文字職人モードの行数・行長の制限
    const tooManyLines = Array.from({ length: 41 }, () => ({ text: "a" }));
    expect((await post(v.id, viewer, baseComment({ isCommentArt: true, artLines: tooManyLines }))).status).toBe(400);
    expect((await post(v.id, viewer, baseComment({ isCommentArt: true, artLines: [{ text: "a".repeat(101) }] }))).status).toBe(400);
    expect((await post(v.id, viewer, baseComment({ isCommentArt: true, artLines: [{ text: "ok", color: "javascript:alert(1)" }] }))).status).toBe(400);
  });

  it("リクエストサイズを制限し、JSON以外の直接投稿を拒否する", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const big = await post(v.id, viewer, { ...baseComment(), padding: "x".repeat(20_000) });
    expect(big.status).toBe(413);
    const form = await call(`/api/videos/${v.id}/comments`, {
      method: "POST",
      token: viewer,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "text=hello",
    });
    expect(form.status).toBe(415);
    // トークンなしの投稿は拒否
    const anon = await call(`/api/videos/${v.id}/comments`, { method: "POST", json: baseComment() });
    expect(anon.status).toBe(401);
  });

  it("同じブラウザからの短時間の連続投稿と同一内容の連投を制限する", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo();
    const ip = freshIp();
    expect((await post(v.id, viewer, baseComment({ text: "A" }), ip, true)).status).toBe(201);
    const tooFast = await post(v.id, viewer, baseComment({ text: "B" }), ip, true);
    expect(tooFast.status).toBe(429);

    // 同じブラウザから同じ内容（最短間隔を空けても拒否）
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5000;
      const dup = await post(v.id, viewer, baseComment({ text: "a " }), ip, true);
      expect(dup.status).toBe(429);
      expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("DUPLICATE");
      // 30秒間に6回を超える投稿は拒否（拒否された重複投稿も回数に含む：A, "a " で2回）
      for (let i = 0; i < 6; i++) {
        const t = 7000 + i * 2500;
        Date.now = () => realNow() + t;
        const r = await post(v.id, viewer, baseComment({ text: `burst-${i}` }), ip, true);
        expect(r.status, `burst ${i}`).toBe(i < 4 ? 201 : 429);
      }
    } finally {
      Date.now = realNow;
    }
    // 多数の人が同じ内容 → 一定数を超えると拒否
    for (let i = 0; i < 5; i++) expect((await post(v.id, viewer, baseComment({ text: "spam" }))).status).toBe(201);
    expect((await post(v.id, viewer, baseComment({ text: "spam" }))).status).toBe(429);
  });

  it("学校のように同じIPアドレスを共有していても、別々の生徒は続けて投稿できる", async () => {
    const v = await seedVideo();
    const sharedIp = freshIp();
    for (let i = 0; i < 10; i++) {
      const r = await post(v.id, "", baseComment({ text: `生徒${i}` }), sharedIp);
      expect(r.status).toBe(201);
    }
  });

  it("コメント受付停止中の動画には投稿できない", async () => {
    const viewer = await login("viewer");
    const v = await seedVideo({ commentsEnabled: false });
    const res = await post(v.id, viewer, baseComment());
    expect(res.status).toBe(403);
  });

  it("管理者はコメントを非表示・削除でき、閲覧者からは見えなくなる", async () => {
    const viewer = await login("viewer");
    const admin = await login("admin");
    const v = await seedVideo();
    const c1 = ((await (await post(v.id, viewer, baseComment({ text: "不適切" }))).json()) as { comment: CommentJson }).comment;
    const c2 = ((await (await post(v.id, viewer, baseComment({ text: "消す" }))).json()) as { comment: CommentJson }).comment;

    expect((await call(`/api/admin/comments/${c1.id}`, { method: "PATCH", token: viewer, json: { hidden: true } })).status).toBe(403);
    expect((await call(`/api/admin/comments/${c1.id}`, { method: "PATCH", token: admin, json: { hidden: true } })).status).toBe(200);
    expect((await call(`/api/admin/comments/${c2.id}`, { method: "DELETE", token: admin })).status).toBe(200);
    expect((await list(v.id, viewer)).comments).toHaveLength(0);

    const adminList = await call(`/api/admin/videos/${v.id}/comments`, { token: admin });
    const al = (await adminList.json()) as { comments: (CommentJson & { hidden: boolean })[] };
    expect(al.comments).toHaveLength(1);
    expect(al.comments[0].hidden).toBe(true);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE id = ?1").bind(c2.id).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("管理者は動画ごとにコメント受付を停止・再開できる", async () => {
    const viewer = await login("viewer");
    const admin = await login("admin");
    const v = await seedVideo();
    await call(`/api/admin/videos/${v.id}`, { method: "PATCH", token: admin, json: { commentsEnabled: false } });
    expect((await post(v.id, viewer, baseComment())).status).toBe(403);
    await call(`/api/admin/videos/${v.id}`, { method: "PATCH", token: admin, json: { commentsEnabled: true } });
    expect((await post(v.id, viewer, baseComment())).status).toBe(201);
  });
});
