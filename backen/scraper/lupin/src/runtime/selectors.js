function countDefinedSelectorFields(selector = {}) {
  return ["css", "text", "role", "testId"].filter((key) => selector[key] !== undefined && selector[key] !== null).length;
}

export function normalizeSelector(selector) {
  if (!selector || typeof selector !== "object") {
    throw new Error("selector must be an object");
  }

  if (countDefinedSelectorFields(selector) !== 1) {
    throw new Error("selector must include exactly one of: css, text, role, testId");
  }

  if (selector.role && !selector.name) {
    throw new Error("selector.role requires selector.name");
  }

  return selector;
}

export function resolveLocator(page, rawSelector) {
  const selector = normalizeSelector(rawSelector);

  if (selector.css) return page.locator(selector.css);
  if (selector.text) return page.getByText(selector.text, { exact: selector.exact === true });
  if (selector.role) return page.getByRole(selector.role, { name: selector.name, exact: selector.exact === true });
  if (selector.testId) return page.getByTestId(selector.testId);

  throw new Error("unsupported selector");
}
