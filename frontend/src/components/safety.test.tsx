// HTMLやJavaScriptを含むコメントが実行・解釈されないことの確認
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../api/types";
import { layoutComments, getFrame } from "../comments/engine";
import { approximateMeasure, drawFrame } from "../comments/render";
import { CommentHistory } from "./CommentHistory";

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;

function comment(extra: Partial<Comment> = {}): Comment {
  return {
    id: 1,
    videoId: "v",
    nickname: `<b>悪意</b>`,
    text: XSS,
    playbackTimeSeconds: 12.3,
    mode: "scroll",
    color: "#FF3B3B",
    fontSize: 24,
    fontFamily: "gothic",
    xPercent: 50,
    yPercent: 50,
    durationSeconds: 4,
    opacity: 1,
    isCommentArt: false,
    artLines: null,
    textAlign: "center",
    lineHeight: 1.2,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("安全なテキスト表示", () => {
  it("コメント履歴ではHTMLを文字として表示し、要素として解釈しない", () => {
    const { container } = render(<CommentHistory comments={[comment()]} total={1} onSeek={() => undefined} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(XSS)).toBeInTheDocument();
    expect(screen.getByText("<b>悪意</b>")).toBeInTheDocument();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("コメントアートは改行・先頭の空白を保持して表示する", () => {
    const text = "   ∧＿∧\n  （ ´∀｀）\n\n    END";
    const { container } = render(
      <CommentHistory comments={[comment({ isCommentArt: true, text, artLines: text.split("\n").map((t) => ({ text: t })) })]} total={1} onSeek={() => undefined} />,
    );
    const pre = container.querySelector("pre.history-art")!;
    expect(pre.textContent).toBe(text);
  });

  it("履歴の時刻をクリックするとその位置へシークする", () => {
    const onSeek = vi.fn();
    render(<CommentHistory comments={[comment()]} total={1} onSeek={onSeek} />);
    screen.getByRole("button", { name: /0:12.3/ }).click();
    expect(onSeek).toHaveBeenCalledWith(12.3);
  });

  it("名無しの表示", () => {
    render(<CommentHistory comments={[comment({ nickname: null, text: "普通" })]} total={1} onSeek={() => undefined} />);
    expect(screen.getByText("名無し")).toBeInTheDocument();
  });

  it("Canvasには fillText で文字列のまま描画し、色・サイズ・先頭の空白を反映する", () => {
    const calls: { method: string; text: string; x: number; y: number; fill?: string; font?: string }[] = [];
    const ctx = {
      font: "",
      fillStyle: "",
      strokeStyle: "",
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: "",
      textBaseline: "",
      clearRect: vi.fn(),
      fillText(this: { fillStyle: string; font: string }, text: string, x: number, y: number) {
        calls.push({ method: "fill", text, x, y, fill: this.fillStyle, font: this.font });
      },
      strokeText(text: string, x: number, y: number) {
        calls.push({ method: "stroke", text, x, y });
      },
    } as unknown as CanvasRenderingContext2D;
    const art = comment({
      isCommentArt: true,
      mode: "free",
      text: "",
      artLines: [{ text: "  <script>" }, { text: "x", color: "#22D3EE", fontSize: 48 }],
      textAlign: "left",
    });
    const frame = getFrame(layoutComments([art], { measure: approximateMeasure }), 13);
    drawFrame(ctx, frame, 854, 480, 1);
    const fills = calls.filter((c) => c.method === "fill");
    expect(fills.map((f) => f.text)).toEqual(["  <script>", "x"]);
    expect(fills[0].fill).toBe("#FF3B3B");
    expect(fills[1].fill).toBe("#22D3EE");
    expect(fills[1].font).toContain("48px");
  });
});
