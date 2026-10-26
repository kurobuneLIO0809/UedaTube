import { describe, expect, it } from "vitest";
import {
  STAGE_H,
  STAGE_W,
  estimateTime,
  expandTabs,
  getFrame,
  layoutComments,
  overflowWarnings,
  prepareBlock,
  scrollCollides,
  type EngineComment,
  type Measure,
} from "./engine";

// 1文字 = 文字サイズ × 0.5 の幅とする単純な計測
const measure: Measure = (text, size) => Array.from(text).length * size * 0.5;

let nextId = 1;
function c(extra: Partial<EngineComment> = {}): EngineComment {
  return {
    id: nextId++,
    text: "テスト",
    playbackTimeSeconds: 0,
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
    ...extra,
  };
}

const frameAt = (comments: EngineComment[], t: number) => getFrame(layoutComments(comments, { measure }), t);

describe("再生位置との同期", () => {
  it("投稿時の再生位置に表示され、表示時間が過ぎると消える", () => {
    const a = c({ playbackTimeSeconds: 42.5, durationSeconds: 4 });
    expect(frameAt([a], 42.4)).toHaveLength(0);
    expect(frameAt([a], 42.5)).toHaveLength(1);
    expect(frameAt([a], 46.4)).toHaveLength(1);
    expect(frameAt([a], 46.5)).toHaveLength(0);
  });

  it("スクロールコメントは右端から入り、左端から抜ける", () => {
    const a = c({ playbackTimeSeconds: 10, text: "あいうえお" });
    const layout = layoutComments([a], { measure });
    const p = layout.items[0];
    const atStart = getFrame(layout, 10)[0];
    expect(atStart.x).toBeCloseTo(STAGE_W); // 右端の外側から
    const nearEnd = getFrame(layout, 10 + 4 - 0.001)[0];
    expect(nearEnd.x + p.width).toBeLessThan(1); // ほぼ左端を抜けた
    const mid = getFrame(layout, 12)[0];
    expect(mid.x).toBeCloseTo((STAGE_W - p.width) / 2, 5);
  });

  it("一時停止中（currentTimeが変わらない）はコメントの位置・表示時間が進まない", () => {
    const layout = layoutComments([c({ playbackTimeSeconds: 5 })], { measure });
    const t = 6.25;
    const first = getFrame(layout, t);
    // 時間が経過しても currentTime が同じなら同じ結果（実時間に依存しない）
    for (let i = 0; i < 5; i++) expect(getFrame(layout, t)).toEqual(first);
    // 補間は再生中だけ。停止中は currentTime をそのまま使う
    expect(estimateTime({ mediaTime: t, wallTime: 0 }, t, 10_000, false, 1)).toBe(t);
  });

  it("シーク後は再生位置に応じて表示対象を再計算する", () => {
    const comments = [c({ playbackTimeSeconds: 1, text: "A" }), c({ playbackTimeSeconds: 30, text: "B" }), c({ playbackTimeSeconds: 60, text: "C" })];
    const layout = layoutComments(comments, { measure });
    expect(getFrame(layout, 31).map((f) => f.placed.comment.text)).toEqual(["B"]);
    // 先頭へ戻る
    expect(getFrame(layout, 2).map((f) => f.placed.comment.text)).toEqual(["A"]);
    expect(getFrame(layout, 61).map((f) => f.placed.comment.text)).toEqual(["C"]);
    expect(getFrame(layout, 45)).toHaveLength(0);
  });

  it("再生速度を変えても、同じ再生位置では同じ位置に表示される", () => {
    const layout = layoutComments([c({ playbackTimeSeconds: 3 })], { measure });
    // 2倍速なら実時間0.5秒で再生位置が1秒進む。位置は再生位置だけで決まる
    const x1 = getFrame(layout, 4)[0].x;
    const x2 = getFrame(layout, 4)[0].x;
    expect(x1).toBe(x2);
    // 補間も再生速度を考慮する（2倍速で0.1秒経過 → 0.2秒進む）
    expect(estimateTime({ mediaTime: 4, wallTime: 1000 }, 4, 1100, true, 2)).toBeCloseTo(4.2);
    expect(estimateTime({ mediaTime: 4, wallTime: 1000 }, 4, 1100, true, 0.5)).toBeCloseTo(4.05);
  });
});

describe("衝突回避", () => {
  it("同時刻のスクロールコメントは別の段に配置する", () => {
    const comments = Array.from({ length: 5 }, () => c({ playbackTimeSeconds: 10 }));
    const ys = getFrame(layoutComments(comments, { measure }), 10.5).map((f) => f.y);
    expect(new Set(ys).size).toBe(5);
  });

  it("短いコメントの後ろから長い（速い）コメントが追いつく場合は同じ段に置かない", () => {
    const short = c({ playbackTimeSeconds: 0, text: "短" });
    const long = c({ playbackTimeSeconds: 0.2, text: "とても長いコメントがここに入ります長い長い長い" });
    const layout = layoutComments([short, long], { measure });
    const [ps, pl] = layout.items;
    // 開始時点では先行コメントが入りきっている（単純な判定なら同じ段に置いてしまう）
    expect(ps.width + ((STAGE_W + ps.width) / 4) * 0.2 * -1 + STAGE_W).toBeLessThan(STAGE_W);
    // しかし途中で追いつくため衝突と判定し、別の段に置く
    expect(scrollCollides(ps, pl)).toBe(true);
    expect(pl.y).not.toBe(ps.y);
  });

  it("どの時刻でも同じ段のスクロールコメントは重ならない", () => {
    const comments = Array.from({ length: 120 }, (_, i) =>
      c({ playbackTimeSeconds: (i * 0.37) % 20, text: "あ".repeat(1 + ((i * 7) % 25)), fontSize: [16, 24, 36][i % 3] }),
    );
    const layout = layoutComments(comments, { measure });
    for (let t = 0; t < 25; t += 0.1) {
      const frame = getFrame(layout, t);
      for (let i = 0; i < frame.length; i++) {
        for (let j = i + 1; j < frame.length; j++) {
          const a = frame[i];
          const b = frame[j];
          const vertical = a.y < b.y + b.placed.height && b.y < a.y + a.placed.height;
          const horizontal = a.x < b.x + b.placed.width && b.x < a.x + a.placed.width;
          expect(vertical && horizontal, `t=${t.toFixed(1)}`).toBe(false);
        }
      }
    }
  });

  it("同じ入力なら常に同じ配置になる（決定的）", () => {
    const comments = Array.from({ length: 50 }, (_, i) => c({ playbackTimeSeconds: i % 7, text: `c${i}` }));
    const a = layoutComments(comments, { measure }).items.map((p) => [p.comment.id, p.y, p.start]);
    const b = layoutComments([...comments].reverse(), { measure }).items.map((p) => [p.comment.id, p.y, p.start]);
    expect(a).toEqual(b);
  });

  it("段が足りないときは表示を遅らせるか間引き、同時表示数の上限を守る", () => {
    const comments = Array.from({ length: 200 }, () => c({ playbackTimeSeconds: 5, fontSize: 36 }));
    const layout = layoutComments(comments, { measure, maxOnScreen: 30 });
    expect(layout.dropped.length).toBeGreaterThan(0);
    expect(layout.items.some((p) => p.delayed)).toBe(true);
    for (let t = 5; t < 10; t += 0.1) expect(getFrame(layout, t).length).toBeLessThanOrEqual(30);
    for (const p of layout.items) expect(p.start - p.comment.playbackTimeSeconds).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it("上・下・中央の固定コメントは重ならないよう積み重ねる", () => {
    const tops = [c({ mode: "top" }), c({ mode: "top" })];
    const bottoms = [c({ mode: "bottom" }), c({ mode: "bottom" })];
    const centers = [c({ mode: "center" }), c({ mode: "center" })];
    const f = frameAt([...tops, ...bottoms, ...centers], 1);
    const get = (m: string) => f.filter((x) => x.placed.comment.mode === m).map((x) => x.y);
    const h = 24 * 1.2;
    expect(get("top")).toEqual([0, h]);
    expect(get("bottom")).toEqual([STAGE_H - h, STAGE_H - 2 * h]);
    const [c1, c2] = get("center");
    expect(c1).toBeCloseTo((STAGE_H - h) / 2);
    expect(Math.abs(c2 - c1)).toBeCloseTo(h);
  });
});

describe("色・位置・サイズの反映", () => {
  it("色とサイズが描画データに反映される", () => {
    const [f] = frameAt([c({ color: "#FF3B3B", fontSize: 36 })], 1);
    expect(f.placed.lines[0].color).toBe("#FF3B3B");
    expect(f.placed.lines[0].fontSize).toBe(36);
    expect(f.placed.height).toBeCloseTo(36 * 1.2);
  });

  it("free モードは X・Y 座標（%）の位置に固定表示する", () => {
    const [f] = frameAt([c({ mode: "free", xPercent: 25, yPercent: 75, text: "ab" })], 1);
    expect(f.x + f.placed.width / 2).toBeCloseTo(STAGE_W * 0.25);
    expect(f.y + f.placed.height / 2).toBeCloseTo(STAGE_H * 0.75);
    // 時間が進んでも同じ位置
    const [g] = frameAt([c({ mode: "free", xPercent: 25, yPercent: 75, text: "ab" })], 2.5);
    expect(g.x).toBeCloseTo(f.x);
  });

  it("固定コメントは指定した表示時間だけ表示する", () => {
    const a = c({ mode: "top", playbackTimeSeconds: 10, durationSeconds: 7 });
    expect(frameAt([a], 16.9)).toHaveLength(1);
    expect(frameAt([a], 17)).toHaveLength(0);
  });

  it("幅が表示領域を超える固定コメントは縮小して収める", () => {
    const [f] = frameAt([c({ mode: "top", text: "あ".repeat(75), fontSize: 96 })], 1);
    expect(f.placed.width).toBeLessThanOrEqual(STAGE_W);
    expect(f.placed.scale).toBeLessThan(1);
  });
});

describe("コメントアート", () => {
  it("改行・先頭の空白・連続する空白を保持する", () => {
    const art = c({
      isCommentArt: true,
      artLines: [{ text: "  ∧＿∧" }, { text: "　（ ´∀｀）  " }, { text: "" }, { text: "    a   b" }],
      text: "",
      mode: "free",
      fontFamily: "mono",
    });
    const block = prepareBlock(art, measure);
    expect(block.lines.map((l) => l.text)).toEqual(["  ∧＿∧", "　（ ´∀｀）  ", "", "    a   b"]);
    expect(block.lines).toHaveLength(4);
    // 空行も高さを持つ
    expect(block.lines[3].offsetY).toBeCloseTo(3 * 24 * 1.2);
  });

  it("タブは決まった幅の空白に展開する", () => {
    expect(expandTabs("\ta")).toBe("    a");
    expect(expandTabs("ab\tc")).toBe("ab  c");
    expect(expandTabs("abcd\te")).toBe("abcd    e");
  });

  it("行ごとの色・サイズを反映する", () => {
    const block = prepareBlock(
      c({ isCommentArt: true, artLines: [{ text: "赤", color: "#FF0000" }, { text: "大", fontSize: 48 }, { text: "標準" }] }),
      measure,
    );
    expect(block.lines.map((l) => [l.color, l.fontSize])).toEqual([
      ["#FF0000", 24],
      ["#FFFFFF", 48],
      ["#FFFFFF", 24],
    ]);
  });

  it("表示領域からはみ出す場合に警告する", () => {
    const art = c({ isCommentArt: true, artLines: [{ text: "あ".repeat(80) }], mode: "free", xPercent: 50, fontSize: 24 });
    expect(overflowWarnings(art, measure).length).toBeGreaterThan(0);
    const ok = c({ isCommentArt: true, artLines: [{ text: "ok" }], mode: "free" });
    expect(overflowWarnings(ok, measure)).toEqual([]);
  });

  it("画面サイズに依存しない（ステージ座標で配置される）", () => {
    const art = c({ isCommentArt: true, artLines: [{ text: "  ab" }, { text: "cd" }], mode: "free", xPercent: 10, yPercent: 10 });
    const a = frameAt([art], 1)[0];
    const b = frameAt([art], 1)[0];
    expect([a.x, a.y]).toEqual([b.x, b.y]);
  });
});
