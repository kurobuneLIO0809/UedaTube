import type { CommentMode, FontFamilyKey, TextAlign } from "../../../shared/constants";
import type { ArtLine } from "../../../shared/validation";

export type VideoStatus = "uploading" | "published" | "hidden" | "failed" | "deleting";

export interface Video {
  id: string;
  title: string;
  description: string;
  category: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasThumbnail: boolean;
  uploadedAt: string | null;
  expiresAt: string | null;
  commentsEnabled: boolean;
  commentCount: number;
  status: VideoStatus;
  thumbnailUrl?: string | null;
}

export interface VideoDetail extends Video {
  streamUrl: string;
  thumbnailUrl: string | null;
  mediaExpiresAt: string;
}

export interface AdminVideo extends Video {
  createdAt: string;
  fileSize: number;
  videoCodec: string | null;
  failureReason: string | null;
  deleteAttempts: number;
  lastDeleteError: string | null;
  expired: boolean;
}

export interface Comment {
  id: number;
  videoId: string;
  nickname: string | null;
  text: string;
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
  createdAt: string;
  hidden?: boolean;
}

export interface CommentList {
  comments: Comment[];
  latestId: number;
  total: number;
  truncated?: boolean;
}

export interface Dashboard {
  now: string;
  videos: Record<string, number>;
  comments: { total: number; hidden: number };
  storageBytes: number;
  expiringSoon: { id: string; title: string; expiresAt: string }[];
  problems: {
    id: string;
    title: string;
    status: VideoStatus;
    failureReason: string | null;
    lastDeleteError: string | null;
    deleteAttempts: number;
    createdAt: string;
  }[];
  cleanupRuns: { id: number; ranAt: string; deletedVideos: number; failedVideos: number; orphanObjects: number; errors: string[] }[];
  limits: { maxUploadBytes: number; partSize: number };
}
