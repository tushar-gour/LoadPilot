interface Server {
  baseUrl: string;
}

class Server implements Server {
  baseUrl: string | "";

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }
}

export { Server };
