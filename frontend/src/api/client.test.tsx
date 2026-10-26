import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoListPage } from "../pages/VideoListPage";
import { ApiError, listVideos, verifyPassphrase } from "./client";
import { getToken, setToken } from "./session";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("APIクライアント", () => {
  it("合言葉は保存せず、トークンだけを sessionStorage に保存する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ token: "v1.abc.def", role: "viewer", expiresAt: new Date(Date.now() + 3600_000).toISOString() })));
    await verifyPassphrase("viewer", "secret-passphrase-123");
    expect(getToken("viewer")).toBe("v1.abc.def");
    const all = JSON.stringify({ ...sessionStorage });
    expect(all).not.toContain("secret-passphrase-123");
    expect(JSON.stringify({ ...localStorage })).not.toContain("secret-passphrase-123");
  });

  it("期限切れのトークンは使わない", () => {
    setToken("viewer", "v1.old.sig", new Date(Date.now() - 1000).toISOString());
    expect(getToken("viewer")).toBeNull();
  });

  it("ネットワーク切断を分かりやすいエラーにする", async () => {
    setToken("viewer", "v1.t.s", new Date(Date.now() + 3600_000).toISOString());
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await listVideos({}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("NETWORK");
  });

  it("401 を受け取ったらトークンを破棄する", async () => {
    setToken("viewer", "v1.t.s", new Date(Date.now() + 3600_000).toISOString());
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "INVALID_TOKEN", message: "期限切れ" } }, 401)));
    await expect(listVideos({})).rejects.toMatchObject({ status: 401 });
    expect(getToken("viewer")).toBeNull();
  });
});

describe("動画一覧画面", () => {
  beforeEach(() => setToken("viewer", "v1.t.s", new Date(Date.now() + 3600_000).toISOString()));

  it("動画が無いときは空の表示", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ videos: [], categories: [], hasMore: false })));
    render(<VideoListPage />);
    expect(await screen.findByText("公開中の動画はまだありません")).toBeInTheDocument();
  });

  it("APIエラーのときはエラー表示と再読み込みボタン", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { code: "INTERNAL", message: "サーバーでエラーが発生しました。" } }, 500)));
    render(<VideoListPage />);
    expect(await screen.findByText("サーバーでエラーが発生しました。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });

  it("動画カードに削除予定日時とコメント数を表示する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          videos: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "理科の実験",
              description: "説明",
              category: "授業",
              durationSeconds: 125,
              width: 1280,
              height: 720,
              hasThumbnail: false,
              thumbnailUrl: null,
              uploadedAt: "2026-10-20T03:00:00.000Z",
              expiresAt: "2026-11-03T03:00:00.000Z",
              commentsEnabled: true,
              commentCount: 7,
              status: "published",
            },
          ],
          categories: ["授業"],
          hasMore: false,
        }),
      ),
    );
    render(<VideoListPage />);
    expect(await screen.findByText("理科の実験")).toBeInTheDocument();
    expect(screen.getByText("コメント 7")).toBeInTheDocument();
    expect(screen.getByText("削除予定")).toBeInTheDocument();
    expect(screen.getByText("2:05")).toBeInTheDocument();
  });
});
