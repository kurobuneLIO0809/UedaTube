// HTTPレスポンスの共通処理（JSON、エラー、CORS、セキュリティヘッダー）

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: string[],
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // APIの応答はキャッシュさせない（期限切れ動画の情報がキャッシュから見えないように）
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

export function errorResponse(err: HttpError): Response {
  return json(
    { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
    err.status,
    err.headers ?? {},
  );
}

/** 本文サイズを制限しながらJSONを読み込む */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type は application/json にしてください。");
  }
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "リクエストが大きすぎます。");
  const buf = await readLimited(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSONの形式が正しくありません。");
  }
}

/** 本文を maxBytes まで読み込む（Content-Lengthを偽った場合にも対応） */
export async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "リクエストが大きすぎます。");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

/** CORS：許可したオリジンのみ。CORSは認証の代わりではない（認証は別途トークンで必ず行う）。 */
export function corsHeaders(request: Request, allowedOrigins: string[]): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
