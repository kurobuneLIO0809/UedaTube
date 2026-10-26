// FFmpeg.wasm の本体（@ffmpeg/core）を public/ffmpeg/ にコピーする。
// 同じサイト（GitHub Pages）から配信するため。外部CDNは使わない（CSPで禁止しているため）。
// コピー先は .gitignore 済み（約32MBのため、リポジトリには入れない）。
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// package.json は exports に含まれないため、wasm の場所からパッケージのフォルダーを求める
// （require では umd 版が返るため、Web Worker の import() で読める esm 版のフォルダーを指定する）
const pkgDir = join(dirname(require.resolve("@ffmpeg/core/wasm")), "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const src = join(pkgDir, "dist", "esm");
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "ffmpeg");
mkdirSync(dest, { recursive: true });
for (const f of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) copyFileSync(join(src, f), join(dest, f));
writeFileSync(
  join(dest, "LICENSE.txt"),
  [
    `このフォルダーのファイルは ${pkg.name}@${pkg.version}（FFmpeg の WebAssembly 版）です。`,
    `ライセンス: ${pkg.license}（FFmpeg / x264 などを含みます）`,
    `ソースコード: https://github.com/ffmpegwasm/ffmpeg.wasm （タグ v${pkg.version}）`,
    "School NICO はこのファイルを改変せずに配布しています。",
    "",
  ].join("\n"),
);
console.log(`copied ${pkg.name}@${pkg.version} -> public/ffmpeg/`);
