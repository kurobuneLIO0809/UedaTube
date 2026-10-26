// GitHub Pages でも動作するハッシュ方式のルーター（#/watch/xxx など）
import { useEffect, useState } from "react";

export type Route =
  | { name: "list" }
  | { name: "watch"; id: string }
  | { name: "admin" }
  | { name: "adminUpload" }
  | { name: "adminVideo"; id: string }
  | { name: "notFound" };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "") || "/";
  const [p] = path.split("?");
  let m: RegExpExecArray | null;
  if (p === "/" || p === "") return { name: "list" };
  if ((m = /^\/watch\/([0-9a-f-]{36})$/.exec(p))) return { name: "watch", id: m[1] };
  if (p === "/admin") return { name: "admin" };
  if (p === "/admin/upload") return { name: "adminUpload" };
  if ((m = /^\/admin\/videos\/([0-9a-f-]{36})$/.exec(p))) return { name: "adminVideo", id: m[1] };
  return { name: "notFound" };
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function href(path: string) {
  return `#${path}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo?.(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
