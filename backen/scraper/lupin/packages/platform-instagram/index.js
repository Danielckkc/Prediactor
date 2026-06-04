import { fetchInstagramPost, fetchInstagramProfile } from "./providers/instagram/fetch.js";
import { searchInstagram } from "./providers/instagram/search.js";

export async function search(args, context) {
  return searchInstagram(args.query, args, context.browserManager);
}

export async function fetchPost(args, context) {
  return fetchInstagramPost(context.scraper, args.url, args, context.browserManager);
}

export async function fetchProfile(args, context) {
  return fetchInstagramProfile(context.scraper, args.url, args, context.browserManager);
}
