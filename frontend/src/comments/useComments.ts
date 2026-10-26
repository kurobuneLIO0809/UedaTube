// コメントの取得と定期ポーリング（他の閲覧者のコメントを反映する）
import { useCallback, useEffect, useRef, useState } from "react";
import { listComments } from "../api/client";
import type { Comment } from "../api/types";
import { config } from "../config";

export interface CommentsState {
  comments: Comment[];
  total: number;
  loading: boolean;
  error: unknown;
  /** 最後の自動更新が失敗したか（表示は維持する） */
  stale: boolean;
}

export function mergeComments(current: Comment[], incoming: Comment[]): Comment[] {
  if (incoming.length === 0) return current;
  const map = new Map(current.map((c) => [c.id, c]));
  for (const c of incoming) map.set(c.id, c);
  return [...map.values()].sort((a, b) => a.id - b.id);
}

export function useComments(videoId: string | null, enabled: boolean) {
  const [state, setState] = useState<CommentsState>({ comments: [], total: 0, loading: true, error: null, stale: false });
  const latestId = useRef(0);
  const lastFull = useRef(0);

  const load = useCallback(
    async (full: boolean, signal?: AbortSignal) => {
      if (!videoId) return;
      try {
        if (full) {
          const r = await listComments(videoId, undefined, signal);
          latestId.current = r.latestId;
          lastFull.current = Date.now();
          setState({ comments: r.comments, total: r.total, loading: false, error: null, stale: false });
        } else {
          const r = await listComments(videoId, latestId.current, signal);
          latestId.current = Math.max(latestId.current, r.latestId);
          setState((s) => ({ ...s, comments: mergeComments(s.comments, r.comments), total: r.total, stale: false }));
        }
      } catch (error) {
        if (signal?.aborted) return;
        setState((s) => (s.loading ? { ...s, loading: false, error } : { ...s, stale: true }));
      }
    },
    [videoId],
  );

  useEffect(() => {
    if (!videoId || !enabled) return;
    const ac = new AbortController();
    latestId.current = 0;
    setState({ comments: [], total: 0, loading: true, error: null, stale: false });
    void load(true, ac.signal);
    const timer = setInterval(() => {
      // タブが非表示のときは通信しない
      if (document.hidden) return;
      const full = Date.now() - lastFull.current >= config.commentFullRefreshMs;
      void load(full, ac.signal);
    }, config.commentPollMs);
    const onVisible = () => {
      if (!document.hidden) void load(false, ac.signal);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ac.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [videoId, enabled, load]);

  const addLocal = useCallback((c: Comment) => {
    setState((s) => ({ ...s, comments: mergeComments(s.comments, [c]), total: s.total + 1 }));
  }, []);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    void load(true);
  }, [load]);

  return { ...state, addLocal, retry };
}
