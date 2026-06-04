import { fetchXPost } from "./providers/x/fetch.js";
import { searchX } from "./providers/x/search.js";

export async function search(args, context) {
  return searchX(args.query, args, context.browserManager);
}

export async function fetchPost(args, context) {
  return fetchXPost(context.scraper, args.url, args, context.browserManager);
}
