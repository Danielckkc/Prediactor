export function getEventPublishedAt(event) {
  return event?.creationDate || event?.createdAt || event?.startDate || null;
}

export function selectPrimaryMarket(markets) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  return (
    markets.find((market) => market?.active && !market?.closed && (market?.endDate || market?.endDateIso)) ||
    markets.find((market) => market?.active && !market?.closed) ||
    markets[0]
  );
}

export function getPrimaryMarketEndDate(markets) {
  const market = selectPrimaryMarket(markets);
  return market?.endDate || market?.endDateIso || null;
}
