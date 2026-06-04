import { fetchYoutubeVideo } from "./providers/youtube/fetch.js";
import { searchYoutube } from "./providers/youtube/search.js";

export async function search(args, context) {
  return searchYoutube(args.query, args, context.fetcher || fetch);
}

export async function fetchPost(args, context) {
  return fetchYoutubeVideo(context.scraper, args.url, args, context.browserManager);
}
