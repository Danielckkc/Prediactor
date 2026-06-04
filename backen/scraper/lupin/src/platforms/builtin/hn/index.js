import { fetchHnItem } from "../../../providers/hn/fetch.js";
import { searchHn } from "../../../providers/hn/search.js";

export async function search(args, context) {
  return searchHn(args.query, args, context.fetcher || fetch);
}

export async function fetchPost(args, context) {
  return fetchHnItem(context.scraper, args.url, args, context.browserManager);
}

