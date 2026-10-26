import { describe, expect, it } from "vitest";
import { validateCommentInput, validateVideoMeta } from "./validation";

const base = { text: "hi", playbackTimeSeconds: 1, mode: "scroll", color: "#ffffff", fontSize: 24, fontFamily: "gothic" };

describe("コメント入力の検証", () => {
  it("正しい入力を正規化する", () => {
    const r = validateCommentInput({ ...base, text: "  こんにちは  ", nickname: "  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe("こんにちは");
      expect(r.value.nickname).toBeNull();
      expect(r.value.color).toBe("#FFFFFF");
      expect(r.value.durationSeconds).toBe(4);
    }
  });

  it("CSSインジェクションになりうる色を拒否する", () => {
    for (const color of ["red", "#fff", "#FFFFFF;", "rgb(0,0,0)", "url(javascript:1)", "#GGGGGG", 123]) {
      expect(validateCommentInput({ ...base, color }).ok, String(color)).toBe(false);
    }
  });

  it("制御文字や双方向テキスト制御文字を拒否する", () => {
    expect(validateCommentInput({ ...base, text: "a\u0000b" }).ok).toBe(false);
    expect(validateCommentInput({ ...base, text: "a‮b" }).ok).toBe(false);
  });

  it("文字職人モードは先頭の空白・空行を保持する", () => {
    const r = validateCommentInput({ ...base, isCommentArt: true, artLines: [{ text: "   a" }, { text: "" }, { text: "\tb  " }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("   a\n\n\tb  ");
  });

  it("空白だけのコメントアートを拒否する", () => {
    expect(validateCommentInput({ ...base, isCommentArt: true, artLines: [{ text: "   " }, { text: "" }] }).ok).toBe(false);
  });
});

describe("動画メタデータの検証", () => {
  it("タイトル必須・長さ制限", () => {
    expect(validateVideoMeta({ title: "", category: "授業" }).ok).toBe(false);
    expect(validateVideoMeta({ title: "a".repeat(101), category: "授業" }).ok).toBe(false);
    expect(validateVideoMeta({ title: "ok", category: "授業" }).ok).toBe(true);
    expect(validateVideoMeta({ title: "改行\nあり", category: "授業" }).ok).toBe(false);
  });
});
