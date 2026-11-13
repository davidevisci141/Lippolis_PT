export const EXERCISE_VIDEO_ERROR = "Inserisci un link HTTPS a YouTube, Vimeo o a un file MP4/WebM.";

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const vimeoHosts = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

export function parseExerciseVideo(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (input.length > 500 || !/^https:\/\//i.test(input) || /[\u0000-\u001f\u007f\\]/.test(input)) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;

  const { hostname, pathname, searchParams, port } = url;
  if (hostname === "youtu.be" || youtubeHosts.has(hostname)) {
    if (port) return null;
    const id = hostname === "youtu.be" ? pathname.match(/^\/([\w-]{11})\/?$/)?.[1]
      : pathname === "/watch" ? searchParams.get("v")
        : pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})\/?$/)?.[1];
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return { kind: "youtube", url: url.href, embedUrl: "https://www.youtube-nocookie.com/embed/" + id };
  }
  if (vimeoHosts.has(hostname)) {
    if (port) return null;
    const match = hostname === "player.vimeo.com" ? pathname.match(/^\/video\/(\d+)\/?$/)
      : pathname.match(/^\/(\d+)(?:\/([a-z0-9]+))?\/?$/i) || pathname.match(/^\/(?:channels\/[^/]+|groups\/[^/]+\/videos)\/(\d+)\/?$/);
    if (!match) return null;
    const hash = match[2] || searchParams.get("h");
    if (hash && !/^[a-z0-9]+$/i.test(hash)) return null;
    return { kind: "vimeo", url: url.href, embedUrl: "https://player.vimeo.com/video/" + match[1] + (hash ? "?h=" + hash : "") };
  }
  if (/\.(?:mp4|webm)$/i.test(pathname)) return { kind: "file", url: url.href, embedUrl: null };
  return null;
}
