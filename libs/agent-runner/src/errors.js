/** A refusal the caller can act on; `code` maps to an HTTP status in the server. */
export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}
