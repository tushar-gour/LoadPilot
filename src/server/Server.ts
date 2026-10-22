/** A backend destination in a server pool. */
class Server {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error(`Invalid backend URL: ${baseUrl}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(`Invalid HTTP backend URL: ${baseUrl}`);
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
  }
}
export { Server };
