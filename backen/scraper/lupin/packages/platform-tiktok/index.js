import { fetchTiktokPost, fetchTiktokProfile } from "./providers/tiktok/fetch.js";
import { searchTiktok } from "./providers/tiktok/search.js";

export async function search(args, context) {
  return searchTiktok(args.query, args, context.browserManager);
}

export async function fetchPost(args, context) {
  return fetchTiktokPost(context.scraper, args.url, args, context.browserManager);
}

export async function fetchProfile(args, context) {
  return fetchTiktokProfile(context.scraper, args.url, args, context.browserManager);
}
