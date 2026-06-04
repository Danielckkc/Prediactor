import { downloadVideo } from "../../providers/video/download.js";

const DOWNLOAD_VIDEO_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Video URL to download." },
    outputDir: { type: "string", description: "Directory to save the file. Defaults to current working directory." },
    audioOnly: { type: "boolean", description: "Extract audio only as MP3. Default: false." },
    subtitles: { type: "boolean", description: "Download subtitles if available. Default: false." },
  },
  required: ["url"],
};

export function getVideoTools() {
  return [
    {
      name: "download_video",
      description:
        "Download a video from YouTube, TikTok, or other supported platforms to a local file. " +
        "Requires video support — install with: lupin setup --with-video. " +
        "Returns the local file path and video metadata.",
      inputSchema: DOWNLOAD_VIDEO_INPUT_SCHEMA,
    },
  ];
}

export async function callVideoTool(name, args, context = {}) {
  switch (name) {
    case "download_video":
      return downloadVideo(args.url, { ...args, onProgress: context.onProgress }, { stateDir: context.stateDir });
    default:
      throw new Error(`Unknown video tool: ${name}`);
  }
}
