import { fetchPolymarketMarket } from "../../../providers/polymarket/fetch.js";
import { searchPolymarket } from "../../../providers/polymarket/search.js";

export async function search(args, context) {
  return searchPolymarket(args.query, args, context.fetcher || fetch);
}

export async function fetchPost(args, context) {
  return fetchPolymarketMarket(context.scraper, args.url, args, context.browserManager);
}

