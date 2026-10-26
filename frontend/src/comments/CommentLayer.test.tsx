// 実際の描画ループ（requestAnimationFrame + video.currentTime）の確認
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentLayer } from "./CommentLayer";
import type { EngineComment } from "./engine";
import { approximateMeasure } from "./render";

let frames: FrameRequestCallback[] = [];
const fills: { text: string; x: number }[] = [];

function flushFrames(n = 1) {
  for (let i = 0; i < n; i++) {
    const q = frames;
    frames = [];
    q.forEach((f) => f(performance.now()));
  }
}

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  seeking = false;
  ended = false;
  playbackRate = 1;
}

const comment: EngineComment = {
  id: 1,
  text: "テスト",
  playbackTimeSeconds: 10,
  mode: "scroll",
  color: "#FFFFFF",
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
};

beforeEach(() => {
  frames = [];
  fills.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // jsdom には Canvas が無いので、描画内容を記録する偽物を使う
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        clearRect: () => undefined,
        strokeText: () => undefined,
        fillText: (text: string, x: number) => fills.push({ text, x }),
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 854, height: 480 } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommentLayer", () => {
  it("一時停止中は描画ループが止まり、コメントの位置が変わらない", () => {
    const video = new FakeVideo() as unknown as HTMLVideoElement;
    (video as unknown as FakeVideo).currentTime = 11;
    render(<CommentLayer video={video} comments={[comment]} visible opacity={1} measure={approximateMeasure} />);
    act(() => flushFrames());
    const x1 = fills.at(-1)!.x;
    expect(fills.at(-1)!.text).toBe("テスト");
    // 停止中は次のフレームを要求しない
    expect(frames).toHaveLength(0);
    // 実時間が経っても currentTime が同じなら再描画しても同じ位置
    video.dispatchEvent(new Event("timeupdate"));
    act(() => flushFrames());
    expect(fills.at(-1)!.x).toBe(x1);
  });

  it("再生中は currentTime に合わせて位置が進み、シークすると表示し直す", () => {
    const v = new FakeVideo();
    const video = v as unknown as HTMLVideoElement;
    v.currentTime = 10.5;
    v.paused = false;
    render(<CommentLayer video={video} comments={[comment]} visible opacity={1} measure={approximateMeasure} />);
    act(() => flushFrames());
    const xa = fills.at(-1)!.x;
    v.currentTime = 12;
    act(() => flushFrames());
    expect(fills.at(-1)!.x).toBeLessThan(xa);

    // コメントの無い位置へシーク
    fills.length = 0;
    v.paused = true;
    v.currentTime = 30;
    video.dispatchEvent(new Event("seeked"));
    act(() => flushFrames(2));
    expect(fills).toHaveLength(0);
    // 先頭付近（コメントの位置）へ戻る
    v.currentTime = 11;
    video.dispatchEvent(new Event("seeked"));
    act(() => flushFrames(2));
    expect(fills.at(-1)!.text).toBe("テスト");
  });

  it("コメントを非表示にすると描画ループを止める", () => {
    const v = new FakeVideo();
    v.paused = false;
    v.currentTime = 11;
    render(<CommentLayer video={v as unknown as HTMLVideoElement} comments={[comment]} visible={false} opacity={1} measure={approximateMeasure} />);
    act(() => flushFrames(3));
    expect(fills).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});
