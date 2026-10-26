// コメント・動画メタデータの入力検証。
// フロントエンドでは事前チェックに、Workerでは最終的な検証（信頼できる側）に使用します。
import {
  COMMENT_MODES,
  DEFAULT_DURATION,
  FONT_FAMILIES,
  LIMITS,
  TEXT_ALIGNS,
  type CommentMode,
  type FontFamilyKey,
  type TextAlign,
} from "./constants";

export interface ArtLine {
  text: string;
  /** 行ごとの文字色（省略時はコメント全体の色） */
  color?: string;
  /** 行ごとの文字サイズ（省略時はコメント全体のサイズ） */
  fontSize?: number;
}

/** 検証済みのコメント入力 */
export interface CommentInput {
  text: string;
  nickname: string | null;
  playbackTimeSeconds: number;
  mode: CommentMode;
  color: string;
  fontSize: number;
  fontFamily: FontFamilyKey;
  xPercent: number;
  yPercent: number;
  durationSeconds: number;
  opacity: number;
  isCommentArt: boolean;
  artLines: ArtLine[] | null;
  textAlign: TextAlign;
  lineHeight: number;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
// 改行・タブ以外の制御文字、および双方向テキスト制御文字を禁止
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOR.test(v);
}

/** 文字数をコードポイント単位で数える（絵文字なども1文字） */
export function charLength(s: string): number {
  return Array.from(s).length;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function inRange(v: unknown, min: number, max: number): v is number {
  return isFiniteNumber(v) && v >= min && v <= max;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/**
 * コメント入力を検証して正規化する。
 * 不正な色・サイズ・位置・表示時間などはすべて拒否する（黙って補正しない）。
 */
export function validateCommentInput(raw: unknown): ValidationResult<CommentInput> {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["リクエストの形式が正しくありません。"] };
  }
  const r = raw as Record<string, unknown>;

  const isCommentArt = r.isCommentArt === true;
  if (r.isCommentArt !== undefined && typeof r.isCommentArt !== "boolean") {
    errors.push("isCommentArt の値が不正です。");
  }

  // ニックネーム
  let nickname: string | null = null;
  if (r.nickname !== undefined && r.nickname !== null) {
    if (typeof r.nickname !== "string") {
      errors.push("ニックネームの形式が不正です。");
    } else {
      const n = r.nickname.trim();
      if (FORBIDDEN_CHARS.test(n) || n.includes("\n") || n.includes("\t")) {
        errors.push("ニックネームに使用できない文字が含まれています。");
      } else if (charLength(n) > LIMITS.nicknameMaxChars) {
        errors.push(`ニックネームは${LIMITS.nicknameMaxChars}文字以内で入力してください。`);
      } else if (n.length > 0) {
        nickname = n;
      }
    }
  }

  // 再生位置
  if (!inRange(r.playbackTimeSeconds, 0, LIMITS.playbackTimeMax)) {
    errors.push("再生位置が不正です。");
  }

  // 表示モード
  const mode = r.mode === undefined ? "scroll" : r.mode;
  if (typeof mode !== "string" || !(COMMENT_MODES as readonly string[]).includes(mode)) {
    errors.push("表示モードが不正です。");
  }

  // 色
  if (!isHexColor(r.color)) errors.push("色は #RRGGBB 形式で指定してください。");

  // サイズ
  if (!Number.isInteger(r.fontSize) || !inRange(r.fontSize, LIMITS.fontSizeMin, LIMITS.fontSizeMax)) {
    errors.push(`文字サイズは${LIMITS.fontSizeMin}〜${LIMITS.fontSizeMax}の整数で指定してください。`);
  }

  // フォント
  const fontFamily = r.fontFamily === undefined ? "gothic" : r.fontFamily;
  if (typeof fontFamily !== "string" || !(FONT_FAMILIES as readonly string[]).includes(fontFamily)) {
    errors.push("フォントが不正です。");
  }

  // 位置
  const xPercent = r.xPercent === undefined ? 50 : r.xPercent;
  const yPercent = r.yPercent === undefined ? 50 : r.yPercent;
  if (!inRange(xPercent, 0, 100)) errors.push("X座標は0〜100%で指定してください。");
  if (!inRange(yPercent, 0, 100)) errors.push("Y座標は0〜100%で指定してください。");

  // 表示時間
  const defaultDuration = mode === "scroll" ? DEFAULT_DURATION.scroll : DEFAULT_DURATION.fixed;
  const durationSeconds = r.durationSeconds === undefined ? defaultDuration : r.durationSeconds;
  if (!inRange(durationSeconds, LIMITS.durationMin, LIMITS.durationMax)) {
    errors.push(`表示時間は${LIMITS.durationMin}〜${LIMITS.durationMax}秒で指定してください。`);
  }

  // 透明度（1 = 不透明）
  const opacity = r.opacity === undefined ? 1 : r.opacity;
  if (!inRange(opacity, LIMITS.opacityMin, LIMITS.opacityMax)) {
    errors.push(`不透明度は${LIMITS.opacityMin}〜${LIMITS.opacityMax}で指定してください。`);
  }

  // 文字配置・行間
  const textAlign = r.textAlign === undefined ? (isCommentArt ? "left" : "center") : r.textAlign;
  if (typeof textAlign !== "string" || !(TEXT_ALIGNS as readonly string[]).includes(textAlign)) {
    errors.push("文字の配置が不正です。");
  }
  const lineHeight = r.lineHeight === undefined ? 1.2 : r.lineHeight;
  if (!inRange(lineHeight, LIMITS.lineHeightMin, LIMITS.lineHeightMax)) {
    errors.push(`行間は${LIMITS.lineHeightMin}〜${LIMITS.lineHeightMax}で指定してください。`);
  }

  // 本文
  let text = "";
  let artLines: ArtLine[] | null = null;
  if (isCommentArt) {
    const lines = r.artLines;
    if (!Array.isArray(lines) || lines.length === 0) {
      errors.push("コメントアートの行がありません。");
    } else if (lines.length > LIMITS.artMaxLines) {
      errors.push(`コメントアートは${LIMITS.artMaxLines}行以内にしてください。`);
    } else {
      const parsed: ArtLine[] = [];
      let total = 0;
      lines.forEach((line, i) => {
        if (typeof line !== "object" || line === null || typeof (line as ArtLine).text !== "string") {
          errors.push(`${i + 1}行目の形式が不正です。`);
          return;
        }
        const l = line as Record<string, unknown>;
        const lineText = normalizeNewlines(l.text as string);
        if (lineText.includes("\n")) {
          errors.push(`${i + 1}行目に改行を含めることはできません。`);
          return;
        }
        if (FORBIDDEN_CHARS.test(lineText)) {
          errors.push(`${i + 1}行目に使用できない文字が含まれています。`);
          return;
        }
        const len = charLength(lineText);
        if (len > LIMITS.artMaxLineChars) {
          errors.push(`${i + 1}行目は${LIMITS.artMaxLineChars}文字以内にしてください。`);
          return;
        }
        total += len;
        const out: ArtLine = { text: lineText };
        if (l.color !== undefined && l.color !== null) {
          if (!isHexColor(l.color)) {
            errors.push(`${i + 1}行目の色が不正です。`);
            return;
          }
          out.color = l.color.toUpperCase();
        }
        if (l.fontSize !== undefined && l.fontSize !== null) {
          if (!Number.isInteger(l.fontSize) || !inRange(l.fontSize, LIMITS.fontSizeMin, LIMITS.fontSizeMax)) {
            errors.push(`${i + 1}行目の文字サイズが不正です。`);
            return;
          }
          out.fontSize = l.fontSize;
        }
        parsed.push(out);
      });
      if (total > LIMITS.artMaxTotalChars) {
        errors.push(`コメントアートは合計${LIMITS.artMaxTotalChars}文字以内にしてください。`);
      }
      if (parsed.length === lines.length) {
        if (!parsed.some((l) => l.text.trim().length > 0)) {
          errors.push("コメントアートが空です。");
        }
        artLines = parsed;
        text = parsed.map((l) => l.text).join("\n");
      }
    }
  } else {
    if (typeof r.text !== "string") {
      errors.push("コメント本文がありません。");
    } else {
      const t = normalizeNewlines(r.text).trim();
      if (t.length === 0) errors.push("コメント本文を入力してください。");
      else if (t.includes("\n")) errors.push("通常コメントでは改行できません。文字職人モードを使ってください。");
      else if (FORBIDDEN_CHARS.test(t)) errors.push("コメントに使用できない文字が含まれています。");
      else if (charLength(t) > LIMITS.commentMaxChars) {
        errors.push(`コメントは${LIMITS.commentMaxChars}文字以内で入力してください。`);
      }
      text = t.replace(/\t/g, " ");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      text,
      nickname,
      playbackTimeSeconds: round(r.playbackTimeSeconds as number, 3),
      mode: mode as CommentMode,
      color: (r.color as string).toUpperCase(),
      fontSize: r.fontSize as number,
      fontFamily: fontFamily as FontFamilyKey,
      xPercent: round(xPercent as number, 2),
      yPercent: round(yPercent as number, 2),
      durationSeconds: round(durationSeconds as number, 2),
      opacity: round(opacity as number, 2),
      isCommentArt,
      artLines,
      textAlign: textAlign as TextAlign,
      lineHeight: round(lineHeight as number, 2),
    },
  };
}

export interface VideoMetaInput {
  title: string;
  description: string;
  category: string;
}

/** 動画のタイトル・説明・カテゴリの検証。partial=true の場合は指定された項目のみ検証。 */
export function validateVideoMeta(
  raw: unknown,
  partial = false,
): ValidationResult<Partial<VideoMetaInput>> {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["形式が不正です。"] };
  const r = raw as Record<string, unknown>;
  const out: Partial<VideoMetaInput> = {};

  const check = (
    key: keyof VideoMetaInput,
    label: string,
    max: number,
    required: boolean,
    multiline: boolean,
  ) => {
    const v = r[key];
    if (v === undefined) {
      if (!partial && required) errors.push(`${label}を入力してください。`);
      if (!partial && !required) out[key] = "";
      return;
    }
    if (typeof v !== "string") {
      errors.push(`${label}の形式が不正です。`);
      return;
    }
    const s = normalizeNewlines(v).trim();
    if (required && s.length === 0) errors.push(`${label}を入力してください。`);
    else if (charLength(s) > max) errors.push(`${label}は${max}文字以内で入力してください。`);
    else if (FORBIDDEN_CHARS.test(s) || (!multiline && s.includes("\n"))) {
      errors.push(`${label}に使用できない文字が含まれています。`);
    } else out[key] = s;
  };
  check("title", "タイトル", LIMITS.titleMaxChars, true, false);
  check("description", "説明文", LIMITS.descriptionMaxChars, false, true);
  check("category", "カテゴリ", LIMITS.categoryMaxChars, true, false);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}
