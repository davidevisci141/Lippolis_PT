const test = require("node:test");
const assert = require("node:assert/strict");

const mediaModule = import("../www/src/exercise-video.mjs");

test("i link video producono una sorgente coerente con il servizio", async () => {
  const { parseExerciseVideo } = await mediaModule;
  assert.deepEqual(parseExerciseVideo(" https://youtu.be/dQw4w9WgXcQ?t=10 "), {
    kind: "youtube",
    url: "https://youtu.be/dQw4w9WgXcQ?t=10",
    embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
  });
  assert.equal(parseExerciseVideo("https://vimeo.com/123456789/a1bc")?.embedUrl, "https://player.vimeo.com/video/123456789?h=a1bc");
  assert.deepEqual(parseExerciseVideo("https://media.example.com/press.MP4?token=test"), {
    kind: "file",
    url: "https://media.example.com/press.MP4?token=test",
    embedUrl: null
  });
  for (const url of [
    "javascript:alert(1)",
    "http://example.com/press.mp4",
    "https://user:password@media.example.com/press.webm",
    "https://youtube.com.example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=dQw4w9WgXcQ",
    "https://player.vimeo.com/video/123?h=a%26other%3Dyes"
  ]) assert.equal(parseExerciseVideo(url), null, url);
});
