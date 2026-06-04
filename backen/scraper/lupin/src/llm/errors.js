/**
 * Thrown for LLM configuration errors that the user must fix before retrying.
 * These should never be caught and silently swallowed — they must propagate
 * to the user with an actionable message.
 */
export class LlmConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmConfigError";
  }
}
