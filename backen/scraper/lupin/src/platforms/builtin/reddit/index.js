import { fetchRedditPost } from "../../../providers/reddit/fetch.js";
import { searchReddit } from "../../../providers/reddit/search.js";

export async function search(args, context) {
  return searchReddit(args.query, args, context.fetcher || fetch, context.browserManager);
}

export async function fetchPost(args, context) {
  return fetchRedditPost(context.scraper, args.url, args, context.browserManager);
}
